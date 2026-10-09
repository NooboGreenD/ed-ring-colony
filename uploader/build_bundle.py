#!/usr/bin/env python3
"""Сборщик пакета кода Colonial Helper: манифест, подпись, публикация.

Пакет — это те же `uploader/*.py`, но с подписанным списком файлов. Именно он
едет к пилотам вместо 22-мегабайтного exe: обычный релиз весит 5–130 КиБ,
потому что качаются только изменившиеся модули.

Типичные вызовы::

    # один раз: ключи канала обновлений
    python uploader/build_bundle.py --keygen

    # в CI: собрать, подписать, опубликовать на сервере
    python uploader/build_bundle.py --out dist/bundle --channel stable \\
        --branch main --notes-file release-notes.md --publish

    # для сборки exe: разложить пакет туда, откуда его заберёт PyInstaller
    python uploader/build_bundle.py --out dist/bundle --embed build/app_bundle

Обновления публикуются на сервере проекта (Админка → Обновления Helper);
этот скрипт — запасной путь публикации через `--publish` и инструмент
первичной настройки ключей. Приватный ключ живёт в `config.json` хранилища
сервера (или в `UPLOADER_SIGN_KEY`), публичный — в `bundle.TRUSTED_KEYS`
внутри сборки. Без ключа скрипт честно откажется подписывать: неподписанный
пакет клиент всё равно не поставит.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import bundle  # noqa: E402

#: Что в пакет не попадает: инструменты сборки и сам лаунчер (он внутри exe).
#: `updater.py` держим в списке и для старых каталогов, где он ещё лежит:
#: обновления теперь идут только через сервер проекта, и модуль GitHub API
#: в пакет пилоту не нужен.
EXCLUDE = {"build_exe.py", "build_bundle.py", "launcher.py", "updater.py"}

#: Переменные окружения для CI.
KEY_ENV = "UPLOADER_SIGN_KEY"
KEY_ID_ENV = "UPLOADER_SIGN_KEY_ID"
PUBLISH_URL_ENV = "UPLOADER_PUBLISH_URL"
PUBLISH_TOKEN_ENV = "UPLOADER_PUBLISH_TOKEN"

#: Канал по ветке: main — стабильный, рабочие ветки — тестовый.
def channel_for_branch(branch: str) -> str:
    name = str(branch or "").strip()
    return "stable" if name in ("", "main", "master") else "beta"


#: VERSION в colonial_helper.py читаем литералом, не импортом: модуль тянет
#: за собой tkinter, а сборщику нужен только номер.
_VERSION_RE = re.compile(r'^VERSION\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)

#: Заголовок свежего раздела ченджлога: «# Раунд 69 — 2.13.2: …».
_ROUND_RE = re.compile(r"^# Раунд\b.*$", re.MULTILINE)

#: Сколько строк ченджлога попадает в заметки релиза.
NOTES_MAX_LINES = 60


def current_version(path: Path) -> str:
    """Версия программы из `colonial_helper.VERSION` (литерал, без импорта)."""
    try:
        match = _VERSION_RE.search(path.read_text(encoding="utf-8"))
    except OSError:
        return ""
    return match.group(1) if match else ""


def latest_changelog(changes_path: Path, max_lines: int = NOTES_MAX_LINES) -> str:
    """Свежий раздел `CHANGES.md` — «небольшой ченджлог» для заметок релиза."""
    try:
        text = changes_path.read_text(encoding="utf-8")
    except OSError:
        return ""
    starts = [m.start() for m in _ROUND_RE.finditer(text)]
    if not starts:
        return text.strip()[:4000]
    begin = starts[0]
    end = starts[1] if len(starts) > 1 else len(text)
    lines = text[begin:end].strip().splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines] + ["…", "", "Полная история — `uploader/CHANGES.md`."]
    return "\n".join(lines).strip()


def bundle_files(source: Path) -> List[str]:
    """Модули программы: все `*.py` каталога, кроме инструментов сборки."""
    return sorted(p.name for p in source.glob("*.py") if p.name not in EXCLUDE)


def bundle_version(source: Path, override: str = "") -> str:
    if override:
        return override.strip().lstrip("vV")
    version = current_version(source / "colonial_helper.py")
    if not version:
        raise SystemExit("Не удалось прочитать VERSION из colonial_helper.py")
    return version


def read_secret(value: str = "") -> Optional[bytes]:
    """Приватный ключ: аргумент → переменная окружения → нет ключа."""
    raw = str(value or os.environ.get(KEY_ENV, "")).strip()
    if not raw:
        return None
    try:
        secret = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise SystemExit(f"{KEY_ENV}: ожидался base64 (32 байта), ошибка: {exc}")
    if len(secret) != 32:
        raise SystemExit(f"{KEY_ENV}: ключ должен быть ровно 32 байта, а не {len(secret)}")
    return secret


def keygen() -> int:
    """Сгенерировать пару ключей и показать, куда что положить."""
    secret = os.urandom(32)
    public = bundle.ed25519_public_key(secret)
    secret_b64 = base64.b64encode(secret).decode("ascii")
    public_b64 = base64.b64encode(public).decode("ascii")
    key_id = "k" + __import__("time").strftime("%Y%m")
    print("Ключи канала обновлений Colonial Helper")
    print("=" * 70)
    print(f"key_id:          {key_id}")
    print(f"ПРИВАТНЫЙ ключ:  {secret_b64}")
    print(f"ПУБЛИЧНЫЙ ключ:  {public_b64}")
    print("=" * 70)
    print("Что сделать:")
    print("  1) приватный ключ — на сервер проекта (Админка → Обновления")
    print("     Helper → «Импортировать приватный ключ») либо в окружение")
    print(f"       {KEY_ENV} / {KEY_ID_ENV}:")
    print( "  2) uploader/bundle.py → TRUSTED_KEYS:")
    print(f'       TRUSTED_KEYS = {{"{key_id}": "{public_b64}"}}')
    print( "  3) пересобрать exe: публичный ключ должен попасть в лаунчер.")
    print("Канал обновлений живёт на сервере проекта, GitHub для обновлений")
    print("не используется. Приватный ключ нигде не хранится: потеряете —")
    print("сгенерируйте новый и выпустите новую базовую сборку с новым")
    print("публичным ключом.")
    return 0


def build(source: Path, out: Path, version: str, channel: str, notes: str,
          min_launcher: str, secret: Optional[bytes], key_id: str) -> Dict[str, Any]:
    """Собрать манифест + zip пакета в каталоге `out`."""
    files = bundle_files(source)
    if "colonial_helper.py" not in files:
        raise SystemExit(f"В {source} нет colonial_helper.py — это не каталог программы")
    manifest = bundle.build_manifest(
        source, version=version, channel=channel, entry=bundle.DEFAULT_ENTRY,
        files=files, min_launcher=min_launcher, notes=notes)
    if secret is not None:
        manifest = bundle.sign_manifest(manifest, secret, key_id)
        problem = bundle.verify_manifest(manifest, {key_id: base64.b64encode(
            bundle.ed25519_public_key(secret)).decode("ascii")})
        if problem:
            raise SystemExit(f"Подпись не прошла собственную проверку: {problem}")
    else:
        print(f"ВНИМАНИЕ: пакет НЕ подписан (нет {KEY_ENV}). "
              "Клиенты такой пакет не поставят.", file=sys.stderr)

    out.mkdir(parents=True, exist_ok=True)
    (out / bundle.MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    archive_path = out / f"{version}.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in manifest["files"]:
            archive.write(source / item["path"], item["path"])
        archive.writestr(bundle.MANIFEST_NAME,
                         json.dumps(manifest, ensure_ascii=False, indent=2))

    size = sum(int(f["size"]) for f in manifest["files"])
    print(f"Пакет {version} ({channel}): {len(manifest['files'])} файлов, "
          f"{size / 1024:.0f} КиБ исходников, архив {archive_path.stat().st_size / 1024:.0f} КиБ")
    return manifest


def embed(source: Path, manifest: Dict[str, Any], target: Path) -> None:
    """Разложить пакет туда, откуда PyInstaller положит его внутрь exe."""
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    for item in manifest["files"]:
        destination = target / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / item["path"], destination)
    (target / bundle.MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Встроенный пакет подготовлен: {target}")


def launcher_version(source: Path) -> str:
    """Версия лаунчера из `launcher.py` (читаем литерал, не импортируя модуль)."""
    import re

    try:
        text = (source / "launcher.py").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r'^LAUNCHER_VERSION\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    return match.group(1) if match else ""


def _post(url: str, token: str, payload: Dict[str, Any], timeout: int = 120,
          allow: Tuple[int, ...] = ()) -> Tuple[int, Dict[str, Any]]:
    """POST JSON на сервер публикации с понятной диагностикой ошибок.

    Коды из `allow` возвращаются вызывающему, а не валят сборку: так 409
    («не хватает файлов») становится частью нормального разговора с сервером.
    """
    if not url or not token:
        raise SystemExit(f"Нужны {PUBLISH_URL_ENV} и {PUBLISH_TOKEN_ENV}")
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}",
                 "User-Agent": "ColonialHelper-CI/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, body = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read().decode("utf-8", "replace")
        if status not in allow:
            raise SystemExit(f"Публикация не удалась: HTTP {status} {body[:500]}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Публикация не удалась: {exc.reason}")
    try:
        data = json.loads(body)
    except ValueError:
        raise SystemExit(f"Сервер ответил не JSON: {body[:200]}")
    if status in allow:
        return status, data
    if not data.get("ok"):
        raise SystemExit(f"Сервер отказал: {data.get('error') or body[:200]}")
    return status, data


def publish_launcher(path: Path, version: str, url: str, publish_url: str, token: str,
                     platform: str = "win64") -> Dict[str, Any]:
    """Сообщить серверу, где лежит новая базовая сборка (exe) и какой у неё хеш."""
    _, data = _post(publish_url, token, {"launcher": {
        "platform": platform,
        "version": version,
        "url": url,
        "sha256": bundle.sha256_file(path),
        "size": path.stat().st_size,
    }})
    print(f"Базовая сборка {version} ({platform}) опубликована: {url}")
    return data


def publish(manifest: Dict[str, Any], archive: Path, url: str, token: str,
            timeout: int = 120) -> Dict[str, Any]:
    """Отправить пакет на сервер (`POST /api/admin/uploader/publish`).

    Разговор в два шага, и это не педантизм: файлы адресуются по sha256, а
    между релизами меняются один-два модуля. Сначала спрашиваем сервер,
    чего у него нет (он отвечает 409 со списком), потом досылаем только это.
    Иначе каждый релиз тащил бы на сервер весь пакет целиком — ровно та
    лишняя перекачка, от которой мы уходим на стороне клиента.
    """
    if not url or not token:
        raise SystemExit(f"Нужны {PUBLISH_URL_ENV} и {PUBLISH_TOKEN_ENV}")

    status, probe = _post(url, token, {"manifest": manifest, "files": {}},
                          timeout=timeout, allow=(409,))
    missing: List[str] = list(probe.get("missing") or []) if status == 409 else []
    if status == 409 and not missing:
        raise SystemExit(f"Сервер отказал: {probe.get('error')}")

    files: Dict[str, str] = {}
    if missing:
        with zipfile.ZipFile(archive) as packed:
            for path in missing:
                files[path] = base64.b64encode(packed.read(path)).decode("ascii")

    payload_kb = sum(len(v) for v in files.values()) / 1024
    _, data = _post(url, token, {
        "manifest": manifest,
        "files": files,
        # Архив нужен серверу для «Восстановить установку»: клиент берёт его,
        # когда локальным файлам верить нельзя и дельта бессмысленна.
        "bundle_base64": base64.b64encode(archive.read_bytes()).decode("ascii"),
    }, timeout=timeout)

    total = len(manifest["files"])
    print(f"Опубликовано: версия {data.get('version')} в канале {data.get('channel')}; "
          f"дослано файлов {len(files)} из {total} ({payload_kb:.0f} КиБ), "
          f"подпись проверена сервером: {data.get('signature_checked')}")
    return data


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Сборка пакета кода Colonial Helper")
    parser.add_argument("--keygen", action="store_true", help="сгенерировать ключи подписи")
    parser.add_argument("--source", default=str(HERE), help="каталог с модулями программы")
    parser.add_argument("--out", default=str(HERE / "dist" / "bundle"), help="куда класть пакет")
    parser.add_argument("--version", default="", help="версия (по умолчанию из colonial_helper.py)")
    parser.add_argument("--channel", default="", help="канал: stable | beta")
    parser.add_argument("--branch", default="", help="ветка (определяет канал, если он не задан)")
    parser.add_argument("--min-launcher", default="1.0.0", help="минимальная версия лаунчера")
    parser.add_argument("--notes", default="", help="описание релиза")
    parser.add_argument("--notes-file", default="", help="файл с описанием релиза")
    parser.add_argument("--key", default="", help=f"приватный ключ base64 (иначе ${KEY_ENV})")
    parser.add_argument("--key-id", default="", help=f"идентификатор ключа (иначе ${KEY_ID_ENV})")
    parser.add_argument("--embed", default="", help="каталог для встраивания пакета в exe")
    parser.add_argument("--publish", action="store_true", help="опубликовать на сервере")
    parser.add_argument("--publish-existing", action="store_true",
                        help="опубликовать уже собранный пакет из --out (без пересборки)")
    parser.add_argument("--publish-url", default="", help=f"адрес публикации (иначе ${PUBLISH_URL_ENV})")
    parser.add_argument("--publish-token", default="", help=f"токен (иначе ${PUBLISH_TOKEN_ENV})")
    parser.add_argument("--publish-launcher", default="", metavar="EXE",
                        help="опубликовать метаданные базовой сборки (путь к exe)")
    parser.add_argument("--launcher-url", default="", help="ссылка на exe для пилотов")
    parser.add_argument("--launcher-version", default="", help="версия лаунчера (иначе из launcher.py)")
    parser.add_argument("--platform", default="win64", help="платформа базовой сборки")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.keygen:
        return keygen()

    source = Path(args.source).resolve()

    if args.publish_existing:
        # Пересборка дала бы другой `released_at` и другую подпись, а значит —
        # артефакт CI и то, что уехало на сервер, были бы разными пакетами.
        out = Path(args.out).resolve()
        manifest = json.loads((out / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
        publish(manifest, out / f"{manifest['version']}.zip",
                args.publish_url or os.environ.get(PUBLISH_URL_ENV, ""),
                args.publish_token or os.environ.get(PUBLISH_TOKEN_ENV, ""))
        return 0

    if args.publish_launcher:
        exe = Path(args.publish_launcher).resolve()
        if not exe.is_file():
            raise SystemExit(f"Нет файла сборки {exe}")
        publish_launcher(
            exe,
            args.launcher_version or launcher_version(source) or "1.0.0",
            args.launcher_url,
            args.publish_url or os.environ.get(PUBLISH_URL_ENV, ""),
            args.publish_token or os.environ.get(PUBLISH_TOKEN_ENV, ""),
            args.platform)
        return 0

    out = Path(args.out).resolve()
    version = bundle_version(source, args.version)
    channel = args.channel or channel_for_branch(args.branch)
    notes = args.notes
    if args.notes_file:
        try:
            notes = Path(args.notes_file).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"Не удалось прочитать {args.notes_file}: {exc}", file=sys.stderr)
    if not notes:
        notes = latest_changelog(source / "CHANGES.md")

    secret = read_secret(args.key)
    key_id = args.key_id or os.environ.get(KEY_ID_ENV, "") or "dev"

    manifest = build(source, out, version, channel, notes, args.min_launcher, secret, key_id)

    if args.embed:
        embed(source, manifest, Path(args.embed).resolve())

    if args.publish:
        publish(manifest, out / f"{version}.zip",
                args.publish_url or os.environ.get(PUBLISH_URL_ENV, ""),
                args.publish_token or os.environ.get(PUBLISH_TOKEN_ENV, ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
