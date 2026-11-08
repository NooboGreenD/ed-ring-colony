"""Удаление Colonial Helper с компьютера: что именно и в каком порядке.

Установка теперь может лежать в любой папке, поэтому «удалить» — это не один
`rmdir`: у программы есть ярлыки, запись в «Программах и компонентах», журналы,
кэш обновлений и (по желанию) настройки с привязкой устройства. Этот модуль
ничего не рисует и ничего не решает за пользователя: он строит **план**
(`build_plan`) и исполняет его (`execute`). Окно удаления только собирает
галочки — так логику можно проверить без экрана.

Три правила, ради которых модуль существует отдельно:

* **ничего лишнего.** Удаляется ровно папка установки и файлы, которые Helper
  создал сам. Корень диска, домашняя папка, `Windows`, `Program Files`
  отказываются удаляться даже если пользователь выбрал их руками;
* **программа может быть запущена.** exe нельзя удалить, пока он работает,
  поэтому остаток удаляется отдельным процессом после выхода (`deferred`);
* **ошибка не оставляет половину.** Каждый шаг независим: не удалось снять
  ярлык — удаление программы продолжится, а пользователь увидит, что именно
  осталось.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

from i18n import tr

import bundle

#: Имя продукта для «Программ и компонентов» Windows.
APP_NAME = "ED Ring Colony — Colonial Helper"
APP_ID = "EDRingColonyColonialHelper"
REG_SUBKEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_ID}"

#: Файлы в профиле пользователя, которые создаёт сама программа.
USER_FILES = (
    ".colonial_helper.json",              # настройки, язык, канал обновлений
    ".colonial_helper_credentials.json",  # токен сайта
    ".colonial_helper_account.json",      # привязка устройства
)
#: Каталоги в профиле: журнал падений Helper.
USER_DIRS = (".colonial_helper",)

#: Что лежит в папке установки и принадлежит программе. Всё остальное в этой
#: папке не трогаем: пользователь мог поставить Helper в свою рабочую папку.
INSTALL_ENTRIES = ("app", "cache", "logs", "state.json", bundle.MARKER_NAME)

#: Папки, которые удалять нельзя ни при каких галочках.
_PROTECTED_NAMES = {"windows", "system32", "program files", "program files (x86)",
                    "programdata", "users", "appdata", "desktop", "documents"}


@dataclass
class UninstallPlan:
    """Что будет удалено. Собирается до подтверждения, чтобы показать итог."""

    root: Path
    paths: List[Path] = field(default_factory=list)
    shortcuts: List[Path] = field(default_factory=list)
    user_files: List[Path] = field(default_factory=list)
    remove_registry: bool = True
    problems: List[str] = field(default_factory=list)
    bytes: int = 0

    @property
    def ok(self) -> bool:
        return not self.problems

    def summary(self) -> Dict[str, object]:
        return {
            "root": str(self.root),
            "paths": [str(path) for path in self.paths],
            "shortcuts": [str(path) for path in self.shortcuts],
            "user_files": [str(path) for path in self.user_files],
            "registry": self.remove_registry,
            "bytes": self.bytes,
            "problems": list(self.problems),
        }


# ---------------------------------------------------------------------------
#  Проверки путей
# ---------------------------------------------------------------------------
def _norm(path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def protected_reason(root: Path, *, home: Optional[Path] = None,
                     extra: Iterable[Path] = ()) -> str:
    """Почему эту папку удалять нельзя (пустая строка — можно)."""
    target = Path(root).expanduser()
    # `resolve()` достраивает относительный путь до текущей папки, поэтому
    # «относительность» проверяем до него — иначе проверка бесполезна.
    if not target.is_absolute():
        return tr("Нужен полный путь к папке установки")
    try:
        resolved = target.resolve()
    except OSError:
        resolved = target.absolute()
    text = _norm(resolved)
    if not resolved.is_absolute():
        return tr("Нужен полный путь к папке установки")
    if text == _norm(resolved.anchor):          # корень диска: C:\, /
        return tr("Это корень диска — удалять его нельзя")
    if resolved.name.lower() in _PROTECTED_NAMES:
        return tr("Это системная папка — выберите папку, куда ставили Helper")
    home_dir = Path(home or Path.home()).expanduser()
    if text == _norm(home_dir):
        return tr("Это домашняя папка пользователя — удалять её нельзя")
    if len(resolved.parts) <= 1:
        return tr("Путь слишком короткий, чтобы быть папкой установки")
    for item in extra:
        if text == _norm(Path(item).expanduser()):
            return tr("Это системная папка — выберите папку, куда ставили Helper")
    return ""


def looks_like_install(root: Path) -> bool:
    """Признаки установки Helper в папке: маркер, состояние или сам лаунчер."""
    folder = Path(root)
    try:
        if bundle.install_marker_path(folder).is_file():
            return True
        if bundle.state_path(folder).is_file():
            return True
        if bundle.versions_dir(folder).is_dir():
            return True
        return (folder / "ColonialHelper.exe").is_file()
    except OSError:
        return False


def directory_size(path: Path) -> int:
    """Сколько занимает папка или файл (ошибки чтения — просто пропускаем)."""
    target = Path(path)
    try:
        if target.is_file():
            return target.stat().st_size
        if not target.is_dir():
            return 0
    except OSError:
        return 0
    total = 0
    for base, _dirs, files in os.walk(target):
        for name in files:
            try:
                total += (Path(base) / name).stat().st_size
            except OSError:
                continue
    return total


# ---------------------------------------------------------------------------
#  План удаления
# ---------------------------------------------------------------------------
def start_menu_dir(appdata: Optional[Path] = None) -> Path:
    base = Path(appdata) if appdata else Path(os.environ.get("APPDATA", Path.home()))
    return base / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "ED Ring Colony"


def desktop_shortcut(desktop: Optional[Path] = None) -> Path:
    folder = Path(desktop) if desktop else Path.home() / "Desktop"
    return folder / "Colonial Helper.lnk"


def build_plan(root: Optional[Path] = None, *, keep_settings: bool = False,
               remove_shortcuts: bool = True, remove_registry: bool = True,
               home: Optional[Path] = None, appdata: Optional[Path] = None,
               desktop: Optional[Path] = None) -> UninstallPlan:
    """Собрать план удаления, ничего не удаляя.

    `keep_settings=True` оставляет в профиле настройки, вход и привязку
    устройства: после повторной установки их не придётся вводить заново.
    """
    folder = Path(root or bundle.install_root()).expanduser()
    plan = UninstallPlan(root=folder, remove_registry=bool(remove_registry))
    home_dir = Path(home or Path.home()).expanduser()

    reason = protected_reason(folder, home=home_dir)
    if reason:
        plan.problems.append(reason)
    elif not looks_like_install(folder):
        plan.problems.append(tr("В папке {path} нет установленной программы",
                                path=str(folder)))

    if not plan.problems:
        for name in INSTALL_ENTRIES:
            candidate = folder / name
            try:
                if candidate.exists() or candidate.is_symlink():
                    plan.paths.append(candidate)
            except OSError:
                continue
        plan.bytes += directory_size(folder)

    if remove_shortcuts:
        menu = start_menu_dir(appdata)
        candidate = menu if menu.is_dir() else menu / "Colonial Helper.lnk"
        try:
            if candidate.exists():
                plan.shortcuts.append(candidate)
        except OSError:
            pass
        shortcut = desktop_shortcut(desktop)
        try:
            if shortcut.is_file():
                plan.shortcuts.append(shortcut)
        except OSError:
            pass

    if not keep_settings:
        for name in USER_FILES:
            candidate = home_dir / name
            try:
                if candidate.is_file():
                    plan.user_files.append(candidate)
            except OSError:
                continue
        for name in USER_DIRS:
            candidate = home_dir / name
            try:
                if candidate.is_dir():
                    plan.user_files.append(candidate)
            except OSError:
                continue
    return plan


# ---------------------------------------------------------------------------
#  Запись в «Программах и компонентах»
# ---------------------------------------------------------------------------
def _winreg():
    """`winreg` только на Windows: на других платформах записи нет."""
    try:
        import winreg  # noqa: PLC0415 - Windows-only, импорт по месту
        return winreg
    except ImportError:
        return None


def current_version(root) -> str:
    """Версия установленного пакета — для колонки «Версия» в списке программ."""
    try:
        state = bundle.load_state(root)
        return str(state.get("current") or "") or "—"
    except Exception:
        return "—"


def register_uninstall(root: Path, executable: Optional[Path] = None,
                       *, version: str = "", api=None) -> List[str]:
    """Добавить запись в «Программы и компоненты» (HKCU, без прав администратора).

    Возвращает список предупреждений: неудача записи в реестр не должна
    отменять установку — программой всё равно можно пользоваться, а удалить её
    можно кнопкой в Setup.
    """
    registry = api or _winreg()
    if registry is None:
        return []
    folder = Path(root).expanduser()
    target = Path(executable) if executable else folder / "ColonialHelper.exe"
    values = {
        "DisplayName": APP_NAME,
        "DisplayVersion": str(version or current_version(folder)),
        "Publisher": "ED Ring Colony",
        "DisplayIcon": str(target),
        "InstallLocation": str(folder),
        "UninstallString": f'"{target}" --uninstall',
        "QuietUninstallString": f'"{target}" --uninstall --silent',
        "NoModify": 1,
        "NoRepair": 1,
    }
    try:
        with registry.CreateKey(registry.HKEY_CURRENT_USER, REG_SUBKEY) as key:
            for name, value in values.items():
                registry.SetValueEx(key, name, 0, registry.REG_SZ, str(value))
        return []
    except OSError as exc:
        return [tr("Не удалось добавить программу в список установленных: {error}",
                   error=exc)]


def registered_install_root(*, api=None) -> Optional[Path]:
    """Папка из «Программ и компонентов» — чтобы Setup нашёл прошлую установку.

    Программу можно поставить в любую папку, поэтому повторный запуск Setup не
    может угадать её по `%LOCALAPPDATA%`: путь берём из записи, которую сделал
    прошлый запуск установщика. Нет записи — `None`, и Setup работает как обычно.
    """
    registry = api or _winreg()
    if registry is None:
        return None
    try:
        with registry.OpenKey(registry.HKEY_CURRENT_USER, REG_SUBKEY) as key:
            value, _kind = registry.QueryValueEx(key, "InstallLocation")
    except (OSError, AttributeError, KeyError):
        return None
    text = str(value or "").strip()
    if not text:
        return None
    folder = Path(text).expanduser()
    return folder if folder.is_dir() else None


def unregister_uninstall(*, api=None) -> List[str]:
    """Убрать запись из «Программ и компонентов»; отсутствие — не ошибка."""
    registry = api or _winreg()
    if registry is None:
        return []
    try:
        registry.DeleteKey(registry.HKEY_CURRENT_USER, REG_SUBKEY)
        return []
    except FileNotFoundError:
        return []
    except OSError as exc:
        return [tr("Не удалось убрать запись из списка установленных: {error}",
                   error=exc)]


# ---------------------------------------------------------------------------
#  Исполнение
# ---------------------------------------------------------------------------
def deferred_delete_script(targets: Iterable[Path], *, wait_pid: Optional[int] = None,
                           pause_seconds: int = 2, attempts: int = 15) -> str:
    """Командный файл, который доудаляет занятые файлы после выхода программы.

    Свой процесс удалить нельзя: Windows держит открытым exe. Поэтому мелкий
    `.cmd` ждёт завершения процесса (или паузу) и повторяет удаление — это
    штатный приём установщиков, а не взлом.
    """
    lines = ["@echo off", "chcp 65001 >nul"]
    if wait_pid:
        lines += [
            ":wait",
            f'tasklist /fi "PID eq {int(wait_pid)}" 2>nul | find "{int(wait_pid)}" >nul',
            "if not errorlevel 1 (",
            "  ping -n 2 127.0.0.1 >nul",
            "  goto wait",
            ")",
        ]
    else:
        lines.append(f"ping -n {max(2, int(pause_seconds) + 1)} 127.0.0.1 >nul")
    lines.append("set /a tries=0")
    lines.append(":again")
    for target in targets:
        path = str(Path(target))
        if Path(target).suffix:
            lines.append(f'del /f /q "{path}" 2>nul')
        else:
            lines.append(f'rmdir /s /q "{path}" 2>nul')
    checks = " ".join(f'"{str(Path(target))}"' for target in targets)
    lines += [
        f"set left=0",
        f"for %%P in ({checks}) do if exist %%P set left=1",
        "if %left%==0 goto done",
        "set /a tries+=1",
        f"if %tries% lss {max(1, int(attempts))} (",
        "  ping -n 2 127.0.0.1 >nul",
        "  goto again",
        ")",
        ":done",
        'del /f /q "%~f0" >nul 2>nul',
    ]
    return "\r\n".join(lines) + "\r\n"


def schedule_deferred_delete(targets: Iterable[Path], *, wait_pid: Optional[int] = None,
                             spawn: Optional[Callable] = None,
                             directory: Optional[Path] = None) -> Optional[Path]:
    """Запустить доудаление отдельным процессом. Возвращает путь к скрипту."""
    items = [Path(target) for target in targets]
    if not items:
        return None
    script_text = deferred_delete_script(items, wait_pid=wait_pid)
    folder = Path(directory or tempfile.mkdtemp(prefix="edrc-uninstall-"))
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / "uninstall-rest.cmd"
    script.write_text(script_text, encoding="utf-8")
    popen = spawn or subprocess.Popen
    kwargs: Dict[str, object] = {"close_fds": True, "cwd": str(folder)}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = (getattr(subprocess, "DETACHED_PROCESS", 0)
                                   | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                   | getattr(subprocess, "CREATE_NO_WINDOW", 0))
    popen(["cmd.exe", "/c", str(script)], **kwargs)
    return script


def execute(plan: UninstallPlan, *, running_executable: Optional[Path] = None,
            remove_tree: Optional[Callable] = None,
            unlink: Optional[Callable] = None,
            registry_remove: Optional[Callable] = None,
            spawn: Optional[Callable] = None) -> Dict[str, object]:
    """Выполнить план. Возвращает, что удалено, что осталось и почему."""
    removed: List[str] = []
    failed: List[str] = []
    warnings: List[str] = list(plan.problems)
    if not plan.ok:
        return {"ok": False, "removed": removed, "failed": failed,
                "warnings": warnings, "deferred": False}

    remove_dir = remove_tree or shutil.rmtree
    remove_file = unlink or (lambda path: Path(path).unlink())

    def drop(path: Path) -> bool:
        target = Path(path)
        try:
            if target.is_dir() and not target.is_symlink():
                remove_dir(target, ignore_errors=False)
            else:
                remove_file(target)
            removed.append(str(target))
            return True
        except OSError as exc:
            failed.append(f"{target}: {exc}")
            return False

    for shortcut in plan.shortcuts:
        drop(shortcut)
    for item in plan.user_files:
        drop(item)

    if plan.remove_registry:
        remover = registry_remove or (lambda: unregister_uninstall())
        warnings += list(remover() or [])

    deferred = False
    running = Path(running_executable or sys.executable)
    try:
        running_dir = running.resolve().parent
    except OSError:
        running_dir = running.parent

    if plan.root.exists():
        if _norm(running_dir) == _norm(plan.root):
            # Из этой папки работает наш exe (или Setup): доудалим после выхода.
            deferred = _defer(plan.root, running, spawn) or False
            if not deferred:
                failed.append(str(plan.root))
        else:
            for item in plan.paths:
                drop(item)
            try:
                if plan.root.exists():
                    remove_dir(plan.root, ignore_errors=False)
                removed.append(str(plan.root))
            except OSError:
                deferred = _defer(plan.root, running, spawn) or False
                if not deferred:
                    failed.append(str(plan.root))

    if removed:
        try:
            bundle.remove_install_marker(plan.root)
        except Exception:
            pass
    return {"ok": not failed, "removed": removed, "failed": failed,
            "warnings": warnings, "deferred": deferred,
            "freed": int(plan.bytes or 0)}


def _defer(root: Path, running: Path, spawn: Optional[Callable]) -> bool:
    if not sys.platform.startswith("win"):
        return False
    try:
        pid = os.getpid()
        schedule_deferred_delete([root], wait_pid=pid, spawn=spawn)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
#  Точки входа
# ---------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    """`--uninstall [--silent] [--root ПАПКА] [--keep-settings]`."""
    args = list(sys.argv[1:] if argv is None else argv)
    silent = "--silent" in args
    keep = "--keep-settings" in args
    root = bundle.install_root()
    for index, arg in enumerate(args):
        if arg == "--root" and index + 1 < len(args):
            root = Path(args[index + 1]).expanduser()

    if silent:
        plan = build_plan(root, keep_settings=keep)
        if not plan.ok:
            print("; ".join(plan.problems), file=sys.stderr)
            return 2
        result = execute(plan)
        print(json.dumps({key: result[key] for key in
                          ("ok", "deferred", "failed", "warnings")}, ensure_ascii=False))
        return 0 if result["ok"] else 1

    try:
        from ui_qt import ensure_app, report_startup_error
        from uninstall_window import UninstallWindow
    except BaseException as exc:  # Qt нет — остаётся честное сообщение
        from ui_qt import report_startup_error

        report_startup_error(exc, title=tr("Не удалось открыть окно удаления"))
        return 1
    app = ensure_app()
    window = UninstallWindow(root)
    window.show()
    app.exec()
    return 0 if not window.last_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
