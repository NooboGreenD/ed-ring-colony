"""Обновление кода Colonial Helper по сети: манифест, дельта, установка.

Что здесь происходит по шагам:

1. `check_for_update()` спрашивает у сервера манифест канала
   (`GET /api/uploader/manifest?channel=stable`), проверяет **подпись** и
   сравнивает версию с установленной.
2. `plan_update()` сверяет список файлов с тем, что уже лежит на диске.
   Совпавшие по sha256 файлы не качаются — обычно из 27 модулей меняются 1–3,
   то есть по сети едет 5–130 КиБ вместо 22 МиБ экзешника.
3. `apply_update()` собирает новую версию в `app/.stage-<version>`, проверяет
   каждый файл по хешу, атомарно переносит каталог на место и переключает
   указатель текущей версии. Программа перезапускается — и работает на новом
   коде; сам `ColonialHelper.exe` при этом не менялся.

Сеть живёт только в этом модуле: `bundle.py` (формат) и `launcher.py` (запуск)
про HTTP ничего не знают и тестируются без сокетов.

Почему адрес обновлений отдельный, а не `site_url` из настроек: адрес сайта
пилот может сменить на свой (self-hosted). Брать оттуда исполняемый код
нельзя — поэтому база обновлений зашита, а любая замена (переменная окружения,
selfhost) всё равно проходит проверку подписи доверенным ключом.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import bundle

try:  # site_config лежит рядом; в тестах модуль может быть недоступен
    from site_config import DEFAULT_SITE_URL
except Exception:  # pragma: no cover - страховка, а не сценарий
    DEFAULT_SITE_URL = "https://edringcolony.ru"

#: База канала обновлений. Не из пользовательских настроек — см. докстринг.
DEFAULT_UPDATE_BASE = f"{DEFAULT_SITE_URL}/api/uploader"
#: Переопределение для отладки и self-hosted (подпись всё равно проверяется).
BASE_ENV = "COLONIAL_HELPER_UPDATE_BASE"

TIMEOUT = (10, 30)
DOWNLOAD_CHUNK = 1024 * 256
MAX_ATTEMPTS = 3
PLATFORM = "win64" if sys.platform.startswith("win") else sys.platform


def update_base(override: str = "") -> str:
    """Адрес API обновлений: явный аргумент → переменная окружения → зашитый."""
    for candidate in (override, os.environ.get(BASE_ENV, "")):
        value = str(candidate or "").strip().rstrip("/")
        if value:
            return value
    return DEFAULT_UPDATE_BASE


# ---------------------------------------------------------------------------
#  HTTP
# ---------------------------------------------------------------------------
def _session(session=None):
    if session is not None:
        return session
    import requests  # локальный импорт: модуль должен импортироваться без сети

    return requests.Session()


def _headers(current: str = "") -> Dict[str, str]:
    return {
        "Accept": "application/json",
        "User-Agent": f"ColonialHelper/{current or 'dev'} (bundle update)",
    }


def _get_json(http, url: str, params: Optional[Dict[str, Any]] = None,
              current: str = "") -> Dict[str, Any]:
    response = http.get(url, params=params or {}, headers=_headers(current), timeout=TIMEOUT)
    if not getattr(response, "ok", False):
        status = getattr(response, "status_code", "?")
        raise RuntimeError(f"HTTP {status} от {url}")
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Сервер вернул не JSON ({url})") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"Неожиданный формат ответа ({url})")
    return data


def _get_bytes(http, url: str, expect_sha: str = "", limit: int = bundle.MAX_FILE_BYTES,
               current: str = "", progress=None) -> bytes:
    """Скачать файл с проверкой размера/хеша и побайтовым прогрессом."""
    with http.get(url, headers=_headers(current), timeout=TIMEOUT, stream=True) as response:
        if not getattr(response, "ok", False):
            status = getattr(response, "status_code", "?")
            raise RuntimeError(f"HTTP {status} при скачивании {url}")
        buffer = io.BytesIO()
        for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK):
            if not chunk:
                continue
            buffer.write(chunk)
            if progress:
                try:
                    progress(buffer.tell())
                except Exception:
                    pass
            if buffer.tell() > limit:
                raise RuntimeError(f"Файл больше допустимого ({limit} байт): {url}")
        data = buffer.getvalue()
    if expect_sha and bundle.sha256_bytes(data) != expect_sha:
        raise RuntimeError(f"Хеш не совпал: {url}")
    return data


# ---------------------------------------------------------------------------
#  Проверка обновлений
# ---------------------------------------------------------------------------
def check_for_update(current: str, channel: str = "stable", launcher_version: str = "",
                     session=None, base: str = "", keys: Optional[Dict[str, str]] = None
                     ) -> Dict[str, Any]:
    """Есть ли на сервере пакет новее установленного.

    Исключений не бросает: вызов идёт из фонового потока при запуске, и
    отсутствие сети не должно мешать работать с уже установленной версией.
    """
    result: Dict[str, Any] = {
        "ok": False,
        "update_available": False,
        "current": str(current or ""),
        "latest": "",
        "manifest": None,
        "error": None,
        # True — пакет требует более свежего лаунчера: нужен новый exe.
        "needs_launcher": False,
        "min_launcher": "",
        "channel": str(channel or "stable"),
        "download_bytes": 0,
        # Канал на сервере может быть намеренно возвращён администратором.
        "rollback": False,
    }
    api = update_base(base)
    try:
        http = _session(session)
        payload = _get_json(http, f"{api}/manifest",
                            params={"channel": channel, "platform": PLATFORM},
                            current=current)
    except Exception as exc:
        result["error"] = f"Сервер обновлений недоступен: {exc}"
        return result

    manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else payload
    problem = bundle.verify_manifest(manifest, keys)
    if problem:
        result["error"] = problem
        return result

    result["ok"] = True
    latest = str(manifest.get("version") or "")
    result["latest"] = latest
    result["min_launcher"] = str(manifest.get("min_launcher") or "")
    comparison = (bundle.version_tuple(latest) > bundle.version_tuple(current)) - (
        bundle.version_tuple(latest) < bundle.version_tuple(current))
    if comparison == 0:
        return result
    # Указатель канала — источник истины. Если администратор откатил его на
    # меньший номер, клиент должен поставить эту версию, а не считать себя
    # «новее и потому актуальным».
    result["rollback"] = comparison < 0
    if launcher_version and not bundle.launcher_supports(manifest, launcher_version):
        # Пакет собран под новый рантайм (появилась библиотека, сменился
        # Python). Код обновить нельзя — нужна новая базовая сборка.
        result["needs_launcher"] = True
        result["manifest"] = manifest
        return result
    result["update_available"] = True
    result["manifest"] = manifest
    return result


# ---------------------------------------------------------------------------
#  План обновления (что качаем, что уже есть)
# ---------------------------------------------------------------------------
def local_index(root) -> Dict[str, Path]:
    """`sha256 -> путь` по всем установленным версиям: источник для переиспользования."""
    index: Dict[str, Path] = {}
    for version in bundle.installed_versions(root):
        manifest = bundle.read_manifest(root, version)
        if not isinstance(manifest, dict):
            continue
        folder = bundle.version_dir(root, version)
        try:
            files = bundle.manifest_files(manifest)
        except bundle.BundleError:
            continue
        for path, meta in files.items():
            candidate = folder / path
            digest = meta["sha256"]
            if digest in index or not candidate.is_file():
                continue
            # Доверяем не записи в манифесте, а самому файлу: он мог испортиться.
            if bundle.sha256_file(candidate) == digest:
                index[digest] = candidate
    return index


def plan_update(root, manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Что придётся скачать: список файлов и суммарный вес."""
    wanted = bundle.manifest_files(manifest)
    index = local_index(root)
    download: List[str] = []
    reuse: List[str] = []
    size = 0
    for path, meta in sorted(wanted.items()):
        if meta["sha256"] in index:
            reuse.append(path)
        else:
            download.append(path)
            size += int(meta["size"] or 0)
    return {"download": download, "reuse": reuse, "bytes": size,
            "total": len(wanted), "version": str(manifest.get("version") or "")}


# ---------------------------------------------------------------------------
#  Установка
# ---------------------------------------------------------------------------
def _stage_from_sources(root, manifest: Dict[str, Any], fetch: Callable[[str, Dict[str, Any]], bytes],
                        progress: Optional[Callable[[int, int], None]] = None) -> Path:
    """Собрать каталог версии: своё — копируем, чужое — берём у `fetch`."""
    version = str(manifest.get("version"))
    stage = bundle.stage_dir(root, version)
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)

    wanted = bundle.manifest_files(manifest)
    index = local_index(root)
    plan = plan_update(root, manifest)
    total = int(plan["bytes"]) or 1
    done = 0
    for path, meta in sorted(wanted.items()):
        target = stage / path
        target.parent.mkdir(parents=True, exist_ok=True)
        source = index.get(meta["sha256"])
        if source is not None:
            shutil.copyfile(source, target)
            continue
        data = fetch(path, meta)
        if bundle.sha256_bytes(data) != meta["sha256"]:
            raise bundle.BundleError(f"Файл {path} не совпал по sha256")
        target.write_bytes(data)
        done += len(data)
        if progress:
            try:
                progress(done, total)
            except Exception:
                pass
    (stage / bundle.MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return stage


def _install_stage(root, manifest: Dict[str, Any], stage: Path,
                   keys: Optional[Dict[str, str]] = None,
                   require_signature: bool = True) -> Dict[str, Any]:
    """Проверить подготовленный каталог и сделать его текущей версией."""
    version = str(manifest.get("version"))
    problem = bundle.verify_directory(stage, manifest, keys, require_signature)
    if problem:
        shutil.rmtree(stage, ignore_errors=True)
        return {"ok": False, "error": problem, "version": version}
    bundle.promote_stage(root, version)
    bundle.activate(root, version)
    bundle.prune_versions(root)
    return {"ok": True, "error": None, "version": version}


def apply_update(root, manifest: Dict[str, Any], progress=None, session=None,
                 base: str = "", keys: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Скачать недостающие файлы пакета и сделать версию текущей."""
    result: Dict[str, Any] = {"ok": False, "version": str(manifest.get("version") or ""),
                              "error": None, "downloaded": 0, "reused": 0}
    problem = bundle.verify_manifest(manifest, keys)
    if problem:
        result["error"] = problem
        return result

    api = update_base(base)
    plan = plan_update(root, manifest)
    result["reused"] = len(plan["reuse"])
    downloaded = 0

    try:
        http = _session(session)

        def fetch(path: str, meta: Dict[str, Any]) -> bytes:
            nonlocal downloaded
            url = f"{api}/blob/{meta['sha256']}"
            last: Optional[Exception] = None
            for _ in range(MAX_ATTEMPTS):
                try:
                    data = _get_bytes(
                        http, url, expect_sha=meta["sha256"],
                        limit=max(int(meta["size"] or 0) + 1024, 4096),
                        progress=(lambda part: progress(downloaded + part, int(plan["bytes"]) or 1))
                        if progress else None)
                    downloaded += len(data)
                    return data
                except Exception as exc:  # сеть/битый файл — пробуем ещё раз
                    last = exc
            raise RuntimeError(f"{path}: {last}")

        stage = _stage_from_sources(root, manifest, fetch, progress)
    except bundle.BundleError as exc:
        result["error"] = str(exc)
        return result
    except Exception as exc:
        result["error"] = f"Обновление не скачалось: {exc}"
        return result

    outcome = _install_stage(root, manifest, stage, keys)
    result.update(outcome)
    result["downloaded"] = downloaded
    return result


def install_from_directory(root, source_dir, manifest: Dict[str, Any],
                           keys: Optional[Dict[str, str]] = None,
                           require_signature: bool = True) -> Dict[str, Any]:
    """Поставить пакет из каталога (встроенный в exe — при первом запуске)."""
    folder = Path(source_dir)

    def fetch(path: str, meta: Dict[str, Any]) -> bytes:
        candidate = folder / path
        if not candidate.is_file():
            raise bundle.BundleError(f"В встроенном пакете нет файла {path}")
        return candidate.read_bytes()

    problem = bundle.verify_manifest(manifest, keys, require_signature)
    if problem:
        return {"ok": False, "error": problem, "version": str(manifest.get("version") or "")}
    try:
        stage = _stage_from_sources(root, manifest, fetch)
    except bundle.BundleError as exc:
        return {"ok": False, "error": str(exc), "version": str(manifest.get("version") or "")}
    return _install_stage(root, manifest, stage, keys, require_signature)


def repair(root, version: str = "", channel: str = "stable", session=None,
           base: str = "", keys: Optional[Dict[str, str]] = None,
           progress=None) -> Dict[str, Any]:
    """«Восстановить установку»: скачать пакет целиком и переложить каталог.

    Нужно, когда файл на диске испортился (антивирус, сбой записи) — тогда
    пофайловая дельта не помогает: локальные копии как раз и врут.
    """
    api = update_base(base)
    result: Dict[str, Any] = {"ok": False, "version": str(version or ""), "error": None}
    try:
        http = _session(session)
        if not version:
            payload = _get_json(http, f"{api}/manifest",
                                params={"channel": channel, "platform": PLATFORM})
            manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else payload
        else:
            payload = _get_json(http, f"{api}/manifest",
                                params={"channel": channel, "version": version,
                                        "platform": PLATFORM})
            manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else payload
        problem = bundle.verify_manifest(manifest, keys)
        if problem:
            result["error"] = problem
            return result
        version = str(manifest.get("version"))
        result["version"] = version
        archive = _get_bytes(http, f"{api}/bundle/{version}.zip",
                             limit=bundle.MAX_BUNDLE_BYTES)
    except Exception as exc:
        result["error"] = f"Не удалось получить пакет: {exc}"
        return result

    try:
        contents = extract_zip(archive, manifest)
    except bundle.BundleError as exc:
        result["error"] = str(exc)
        return result

    def fetch(path: str, meta: Dict[str, Any]) -> bytes:
        return contents[path]

    try:
        # При ремонте локальным копиям не верим: собираем каталог только из
        # свежескачанного архива.
        stage = bundle.stage_dir(root, version)
        shutil.rmtree(stage, ignore_errors=True)
        bundle.write_bundle_files(stage, manifest, contents)
    except bundle.BundleError as exc:
        result["error"] = str(exc)
        return result
    except OSError as exc:
        result["error"] = f"Не удалось записать файлы: {exc}"
        return result

    outcome = _install_stage(root, manifest, stage, keys)
    result.update(outcome)
    if progress:
        try:
            progress(len(archive), len(archive))
        except Exception:
            pass
    return result


def extract_zip(data: bytes, manifest: Dict[str, Any]) -> Dict[str, bytes]:
    """Развернуть zip пакета в память, сверяясь с манифестом.

    Из архива берём **только** то, что перечислено в подписанном манифесте:
    лишние записи (в том числе с путями наружу) просто игнорируются.
    """
    wanted = bundle.manifest_files(manifest)
    out: Dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for path, meta in wanted.items():
                try:
                    info = archive.getinfo(path)
                except KeyError:
                    raise bundle.BundleError(f"В архиве нет файла {path}")
                if info.file_size > bundle.MAX_FILE_BYTES:
                    raise bundle.BundleError(f"Файл {path} слишком велик")
                blob = archive.read(info)
                if bundle.sha256_bytes(blob) != meta["sha256"]:
                    raise bundle.BundleError(f"Файл {path} не совпал по sha256")
                out[path] = blob
    except zipfile.BadZipFile as exc:
        raise bundle.BundleError(f"Архив пакета повреждён: {exc}") from exc
    return out


# ---------------------------------------------------------------------------
#  Обновление самого лаунчера (редкий случай)
# ---------------------------------------------------------------------------
def check_launcher(launcher_version: str, session=None, base: str = "") -> Dict[str, Any]:
    """Есть ли более свежая базовая сборка (exe) — спрашиваем наш сервер."""
    api = update_base(base)
    result: Dict[str, Any] = {"ok": False, "update_available": False, "version": "",
                              "url": "", "sha256": "", "size": 0, "error": None}
    try:
        http = _session(session)
        payload = _get_json(http, f"{api}/launcher", params={"platform": PLATFORM},
                            current=launcher_version)
    except Exception as exc:
        result["error"] = f"Сервер обновлений недоступен: {exc}"
        return result
    result["ok"] = True
    result["version"] = str(payload.get("version") or "")
    result["url"] = str(payload.get("url") or "")
    result["sha256"] = str(payload.get("sha256") or "").lower()
    result["size"] = int(payload.get("size") or 0)
    if not result["url"]:
        result["error"] = "сервер не отдал ссылку на сборку"
        return result
    result["update_available"] = (
        bundle.version_tuple(result["version"]) > bundle.version_tuple(launcher_version))
    return result


def download_launcher(info: Dict[str, Any], dest_dir, progress=None, session=None) -> Dict[str, Any]:
    """Скачать новую базовую сборку в указанную папку (пишем через .part)."""
    result: Dict[str, Any] = {"ok": False, "path": "", "size": 0, "error": None}
    url = str((info or {}).get("url") or "")
    if not url:
        result["error"] = "нет ссылки на сборку"
        return result
    folder = Path(dest_dir)
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        result["error"] = f"Не удалось создать папку {folder}: {exc}"
        return result
    name = url.rstrip("/").rsplit("/", 1)[-1] or "ColonialHelper.exe"
    if not name.lower().endswith((".exe", ".zip", ".msi")):
        name = "ColonialHelper.exe"
    target = folder / name
    tmp = target.with_suffix(target.suffix + ".part")
    expect = str((info or {}).get("sha256") or "").lower()
    done = 0
    try:
        http = _session(session)
        with http.get(url, stream=True, timeout=TIMEOUT,
                      headers=_headers("launcher")) as response:
            if not getattr(response, "ok", False):
                result["error"] = f"HTTP {getattr(response, 'status_code', '?')} при скачивании"
                return result
            total = int(response.headers.get("Content-Length") or (info or {}).get("size") or 0)
            with open(tmp, "wb") as handle:
                for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    done += len(chunk)
                    if progress:
                        try:
                            progress(done, total)
                        except Exception:
                            pass
        if expect and bundle.sha256_file(tmp) != expect:
            tmp.unlink(missing_ok=True)
            result["error"] = "хеш скачанной сборки не совпал"
            return result
        tmp.replace(target)
    except Exception as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        result["error"] = f"Скачивание прервано: {exc}"
        return result
    result.update({"ok": True, "path": str(target), "size": done})
    return result


# ---------------------------------------------------------------------------
#  Перезапуск
# ---------------------------------------------------------------------------
def restart_command() -> List[str]:
    """Чем перезапускать программу: сам exe или `python colonial_helper.py`."""
    if getattr(sys, "frozen", False):
        return [sys.executable] + list(sys.argv[1:])
    entry = Path(sys.argv[0]).resolve()
    return [sys.executable, str(entry)] + list(sys.argv[1:])


def restart_program(spawn=None) -> bool:
    """Запустить новый процесс и попросить текущий завершиться.

    Возвращает True, если процесс стартовал: решение «выходить ли сейчас»
    принимает интерфейс — ему нужно успеть закрыть окна и сохранить настройки.
    """
    command = restart_command()
    launch = spawn or subprocess.Popen
    try:
        kwargs: Dict[str, Any] = {"close_fds": True}
        if sys.platform.startswith("win"):
            # Новый процесс не должен умереть вместе с текущим окном консоли.
            kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        launch(command, **kwargs)
        return True
    except Exception:
        return False
