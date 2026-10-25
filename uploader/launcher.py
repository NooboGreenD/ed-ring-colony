"""Загрузчик Colonial Helper: находит свежий пакет кода и запускает его.

Это точка входа `ColonialHelper.exe`. Сам exe больше не содержит программу —
в нём лежат Python, tkinter, ttkbootstrap, requests и *встроенная копия*
пакета кода на случай первого запуска. Рабочий код живёт в
`%LOCALAPPDATA%\\ColonialHelper\\app\\<версия>` и обновляется по сети
пофайлово (см. `bundle_updater.py`).

Порядок запуска::

    Setup.exe → устанавливает ColonialHelper.exe и ярлыки
    exe → launcher.main() → стартовый экран (новости сайта + Galnet)
          ├─ «Запустить» → выбор/проверка версии, испытательный запуск и rollback
          └─ «Обновить» → подписанный пакетный updater → установка версии

При прямом запуске с `--run-helper` bootstrap-поток запускает Helper без экрана.

Главное правило: **что бы ни случилось, программа должна запуститься.**
Любая ошибка обновлений заканчивается запуском того кода, который точно есть:
установленной версии, предыдущей или встроенной в exe.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import bundle

#: Версия лаунчера. Растёт, когда меняется рантайм (новая библиотека, другой
#: Python) или сам механизм запуска. Пакет кода объявляет `min_launcher`:
#: если он выше — программа попросит скачать новую базовую сборку.
LAUNCHER_VERSION = "1.1.0"

#: Каталог со встроенным пакетом внутри собранного exe.
EMBEDDED_DIR = "app_bundle"

#: Что лаунчер сообщает запущенному коду (читает `colonial_helper`).
ENV_LAUNCHER = "COLONIAL_HELPER_LAUNCHER"
ENV_VERSION = "COLONIAL_HELPER_ACTIVE_VERSION"
ENV_ROOT = "COLONIAL_HELPER_HOME"

#: Модули, которые обязаны перечитаться из пакета, а не остаться копией из exe.
RELOAD_MODULES = ("bundle", "bundle_updater")


def log_path(root) -> Path:
    return Path(root) / "logs" / "launcher.log"


def log(root, message: str) -> None:
    """Короткий журнал запуска: он нужен, когда «программа не открывается»."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"{stamp} {message}"
    try:
        path = log_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
    # В собранном exe (`--windowed`) stdout может отсутствовать.
    try:
        print(f"[launcher] {message}")
    except Exception:
        pass


def frozen_dir() -> Path:
    """Каталог, куда PyInstaller распаковал ресурсы (или папка исходников)."""
    base = getattr(sys, "_MEIPASS", "")
    if base:
        return Path(base)
    return Path(__file__).resolve().parent


def _path_is_inside(path: str, directory: str) -> bool:
    """Проверить принадлежность пути каталогу, включая Windows без учёта регистра."""
    try:
        candidate = os.path.normcase(os.path.abspath(path))
        parent = os.path.normcase(os.path.abspath(directory))
        return os.path.commonpath((candidate, parent)) == parent
    except (OSError, ValueError):
        return False


def _is_pyinstaller_temp_path(path: str, extraction_dir: str) -> bool:
    """Распознать и текущий, и оставшийся от предыдущего процесса каталог `_MEI`."""
    if extraction_dir and _path_is_inside(path, extraction_dir):
        return True
    normalized = os.path.normcase(os.path.abspath(path))
    return any(part.lower().startswith("_mei") for part in Path(normalized).parts)


def _readable_ca_bundle(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def configure_tls_ca_bundle(root, bundled_path=None, extraction_dir=None) -> Optional[str]:
    """Закрепить CA bundle вне временного `_MEI` каталога PyInstaller.

    PyInstaller onefile задаёт путь certifi внутри `%TEMP%\\_MEI...`. Если
    Windows очистит этот временный каталог, уже работающий процесс продолжит
    использовать удалённый путь и все новые HTTPS-запросы Requests начнут
    падать с `invalid path`. Копируем штатный certifi bundle в постоянный
    каталог приложения до импорта кода с Requests и направляем TLS-клиенты
    туда. Проверка TLS не отключается.

    Внешний пользовательский bundle сохраняется, если он существует и не
    лежит во временном каталоге приложения. Устаревшие пути `_MEI` заменяются.
    """
    extraction_dir = str(extraction_dir or getattr(sys, "_MEIPASS", "") or "")
    if bundled_path is None:
        if not extraction_dir:
            return None
        bundled_path = Path(extraction_dir) / "certifi" / "cacert.pem"
    else:
        bundled_path = Path(bundled_path)

    target = None
    try:
        if _readable_ca_bundle(bundled_path):
            content = bundled_path.read_bytes()
            digest = hashlib.sha256(content).hexdigest()[:16]
            cert_dir = Path(root) / "certs"
            cert_dir.mkdir(parents=True, exist_ok=True)
            target = cert_dir / f"cacert-{digest}.pem"
            if not _readable_ca_bundle(target) or target.read_bytes() != content:
                temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                temporary.write_bytes(content)
                os.replace(temporary, target)
        else:
            # Если исходный `_MEI` уже удалён, используем последний ранее
            # закреплённый certifi snapshot. При отсутствии копии ниже ничего
            # не ослабляем — Requests останется с проверкой TLS и сообщит ошибку.
            cert_dir = Path(root) / "certs"
            candidates = sorted(cert_dir.glob("cacert-*.pem"),
                                key=lambda item: item.stat().st_mtime, reverse=True)
            target = next((item for item in candidates if _readable_ca_bundle(item)), None)
    except OSError as exc:
        log(root, f"не удалось закрепить CA bundle: {exc}")

    if target is None:
        log(root, f"CA bundle недоступен: {bundled_path}")
        return None

    target_text = str(target.resolve())

    def has_custom_bundle(variable: str) -> bool:
        configured = os.environ.get(variable, "").strip()
        if not configured:
            return False
        configured_path = Path(configured).expanduser()
        is_ephemeral = _is_pyinstaller_temp_path(configured, extraction_dir)
        return _readable_ca_bundle(configured_path) and not is_ephemeral

    # Requests gives REQUESTS_CA_BUNDLE precedence over CURL_CA_BUNDLE. Do not
    # create a new REQUESTS override when a valid CURL override already exists.
    request_bundle = has_custom_bundle("REQUESTS_CA_BUNDLE")
    curl_bundle = has_custom_bundle("CURL_CA_BUNDLE")
    if not request_bundle:
        if curl_bundle:
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
        else:
            os.environ["REQUESTS_CA_BUNDLE"] = target_text
    if not curl_bundle:
        os.environ["CURL_CA_BUNDLE"] = target_text

    if not has_custom_bundle("SSL_CERT_FILE"):
        os.environ["SSL_CERT_FILE"] = target_text

    # PyInstaller may also point OpenSSL at a directory under `_MEI`; discard
    # only a stale/ephemeral override, not a valid user-provided CA directory.
    cert_dir_override = os.environ.get("SSL_CERT_DIR", "").strip()
    if cert_dir_override:
        directory = Path(cert_dir_override).expanduser()
        is_ephemeral = _is_pyinstaller_temp_path(cert_dir_override, extraction_dir)
        if is_ephemeral or not directory.is_dir():
            os.environ.pop("SSL_CERT_DIR", None)

    return target_text


def embedded_bundle() -> Tuple[Optional[Path], Optional[Dict[str, Any]]]:
    """Встроенный в сборку пакет: каталог и его манифест (если есть)."""
    folder = frozen_dir() / EMBEDDED_DIR
    manifest_path = folder / bundle.MANIFEST_NAME
    if not manifest_path.is_file():
        return None, None
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return folder, None
    return folder, data if isinstance(data, dict) else None


def install_embedded(root, folder: Path, manifest: Dict[str, Any]) -> str:
    """Разложить встроенный пакет. Возвращает версию или пустую строку."""
    import bundle_updater

    # Подпись встроенного пакета проверяем, только если в сборке есть ключи:
    # он и так приехал внутри exe, а отказ поставить его означал бы, что
    # программа вообще не запускается.
    result = bundle_updater.install_from_directory(
        root, folder, manifest, require_signature=bool(bundle.trusted_keys()))
    if not result.get("ok"):
        log(root, f"встроенный пакет не установлен: {result.get('error')}")
        return ""
    version = str(result.get("version") or "")
    log(root, f"установлен встроенный пакет {version}")
    # Встроенная копия приехала вместе с exe: считаем её заведомо рабочей,
    # иначе первый же запуск нового exe был бы «на испытательном сроке».
    bundle.mark_healthy(root, version)
    return version


def choose_version(root, embedded_dir: Optional[Path],
                   embedded_manifest: Optional[Dict[str, Any]],
                   record_launch: bool = True) -> str:
    """Какую версию запускать. Здесь же — откат и лечение установки."""
    state = bundle.load_state(root)
    current = str(state.get("current") or "")

    if current and bundle.needs_rollback(state):
        previous = bundle.rollback(root)
        log(root, f"версия {current} не отметилась здоровой — откат на "
                  f"{previous or 'встроенную'}")
        current = previous

    if current:
        problem = bundle.verify_installed(root, current, require_signature=False)
        if problem:
            log(root, f"версия {current} повреждена: {problem}")
            previous = bundle.rollback(root)
            if previous and not bundle.verify_installed(root, previous, require_signature=False):
                log(root, f"работаем на предыдущей версии {previous}")
                current = previous
            else:
                current = ""

    embedded_version = str((embedded_manifest or {}).get("version") or "")
    need_embedded = bool(embedded_version) and (
        not current
        or bundle.version_tuple(embedded_version) > bundle.version_tuple(current))
    if need_embedded and embedded_dir is not None and embedded_manifest is not None:
        if current:
            log(root, f"в сборке пакет {embedded_version} новее установленного {current}")
        installed = install_embedded(root, embedded_dir, embedded_manifest)
        if installed:
            current = installed

    if current and record_launch:
        bundle.note_launch(root, current)
    return current


def activate_path(root, version: str) -> Path:
    """Поставить каталог версии первым в `sys.path` и сбросить кэш модулей."""
    folder = bundle.version_dir(root, version)
    path = str(folder)
    while path in sys.path:
        sys.path.remove(path)
    sys.path.insert(0, path)
    # `bundle`/`bundle_updater` уже импортированы из exe. Программа должна
    # работать с их копиями ИЗ ПАКЕТА: иначе логику обновлений нельзя было бы
    # починить обновлением — только новым exe.
    for name in RELOAD_MODULES:
        sys.modules.pop(name, None)
    return folder


def entry_module(manifest: Optional[Dict[str, Any]]) -> str:
    entry = str((manifest or {}).get("entry") or bundle.DEFAULT_ENTRY)
    return Path(entry).stem or "colonial_helper"


def run_module(name: str) -> int:
    """Импортировать модуль программы и отдать ему управление."""
    module = importlib.import_module(name)
    main = getattr(module, "main", None)
    if main is None:
        raise RuntimeError(f"в модуле {name} нет функции main()")
    result = main()
    return int(result or 0)


def report_failure(root, message: str, details: str = "") -> None:
    """Рассказать пользователю, почему не запустилось, и записать в журнал."""
    log(root, message)
    if details:
        log(root, details)
    try:
        import tkinter
        from tkinter import messagebox

        window = tkinter.Tk()
        window.withdraw()
        messagebox.showerror(
            "Colonial Helper — не удалось запустить",
            f"{message}\n\nПодробности: {log_path(root)}")
        window.destroy()
    except Exception:
        pass


def run_helper(argv: Optional[List[str]] = None) -> int:
    """Запустить Colonial Helper через прежний проверенный bootstrap-поток."""
    args = list(sys.argv[1:] if argv is None else argv)
    root = bundle.install_root()
    embedded_dir, embedded_manifest = embedded_bundle()

    if "--launcher-version" in args:
        print(LAUNCHER_VERSION)
        return 0

    if "--bundle-info" in args:
        state = bundle.load_state(root)
        print(json.dumps({
            "launcher": LAUNCHER_VERSION,
            "root": str(root),
            "current": state.get("current", ""),
            "previous": state.get("previous", ""),
            "pending": state.get("pending"),
            "installed": bundle.installed_versions(root),
            "embedded": (embedded_manifest or {}).get("version", ""),
        }, ensure_ascii=False, indent=2))
        return 0

    # Run before choose_version/run_module: both the updater and app code can
    # make HTTPS requests, and neither may capture a transient _MEI CA path.
    configure_tls_ca_bundle(root)

    if "--reinstall" in args and embedded_dir and embedded_manifest:
        # Аварийный ход: «поставь то, что в exe, и забудь про скачанное».
        install_embedded(root, embedded_dir, embedded_manifest)

    version = ""
    try:
        version = choose_version(root, embedded_dir, embedded_manifest)
    except Exception as exc:  # обновления не должны мешать запуску
        log(root, f"подготовка версии не удалась: {exc}")
        log(root, traceback.format_exc())

    os.environ[ENV_LAUNCHER] = LAUNCHER_VERSION
    os.environ.setdefault(ENV_ROOT, str(root))

    if version:
        manifest = bundle.read_manifest(root, version)
        try:
            activate_path(root, version)
            os.environ[ENV_VERSION] = version
            log(root, f"запуск версии {version}")
            return run_module(entry_module(manifest))
        except Exception as exc:
            log(root, f"версия {version} не запустилась: {exc}")
            log(root, traceback.format_exc())
            # Падение на старте — повод откатиться: отметку «здорова» ставит
            # сама программа, значит, до неё дело не дошло.
            previous = bundle.rollback(root)
            if previous:
                log(root, f"откат на {previous} после ошибки запуска")

    # Последняя линия обороны: код, встроенный в exe.
    if embedded_dir is not None:
        try:
            path = str(embedded_dir)
            if path not in sys.path:
                sys.path.insert(0, path)
            os.environ[ENV_VERSION] = str((embedded_manifest or {}).get("version") or "")
            log(root, "запуск встроенной копии программы")
            return run_module(entry_module(embedded_manifest))
        except Exception as exc:
            report_failure(root, f"Программа не запускается: {exc}",
                           traceback.format_exc())
            return 1

    report_failure(root, "Не найден код программы: ни установленного пакета, "
                         "ни встроенной копии")
    return 1


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    direct_flags = {"--run-helper", "--reinstall", "--launcher-version", "--bundle-info"}
    if any(flag in args for flag in direct_flags):
        helper_args = [arg for arg in args if arg != "--run-helper"]
        return run_helper(helper_args)

    root = bundle.install_root()
    embedded_dir, embedded_manifest = embedded_bundle()
    try:
        from launcher_ui import show_launcher
        launch_requested = show_launcher(root, embedded_dir, embedded_manifest)
    except Exception as exc:
        log(root, f"стартовый экран не загрузился: {exc}; запускаем Helper напрямую")
        launch_requested = True
    return run_helper(args) if launch_requested else 0


if __name__ == "__main__":
    raise SystemExit(main())
