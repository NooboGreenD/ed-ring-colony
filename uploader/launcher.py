"""Загрузчик Colonial Helper: находит свежий пакет кода и запускает его.

Это точка входа `ColonialHelper.exe`. Сам exe больше не содержит программу —
в нём лежат Python, tkinter, ttkbootstrap, requests и *встроенная копия*
пакета кода на случай первого запуска. Рабочий код живёт в
`%LOCALAPPDATA%\\ColonialHelper\\app\\<версия>` и обновляется по сети
пофайлово (см. `bundle_updater.py`).

Порядок запуска::

    exe → launcher.main()
          ├─ есть установленная версия? нет → раскладываем встроенную
          ├─ версия не отметилась здоровой два запуска? → откат на прошлую
          ├─ sha256 всех файлов сходятся с подписанным манифестом? нет → откат
          ├─ встроенный пакет новее установленного? → ставим встроенный
          └─ sys.path ← каталог версии, import colonial_helper, main()

Главное правило: **что бы ни случилось, программа должна запуститься.**
Любая ошибка обновлений заканчивается запуском того кода, который точно есть:
установленной версии, предыдущей или встроенной в exe.
"""

from __future__ import annotations

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
LAUNCHER_VERSION = "1.0.0"

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
                   embedded_manifest: Optional[Dict[str, Any]]) -> str:
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

    if current:
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


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    root = bundle.install_root()

    if "--launcher-version" in args:
        print(LAUNCHER_VERSION)
        return 0

    embedded_dir, embedded_manifest = embedded_bundle()

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


if __name__ == "__main__":
    raise SystemExit(main())
