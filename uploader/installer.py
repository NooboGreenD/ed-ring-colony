"""First-run Windows installer for the Colonial Helper launcher.

The window itself lives in :mod:`installer_window` and is written in plain
PySide6; this module keeps the install logic, which is fully testable without a
display.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional
from i18n import tr

import bundle
import uninstall

APP_NAME = "ED Ring Colony — Colonial Helper"
EXECUTABLE = "ColonialHelper.exe"
PAYLOAD_DIR = "payload"

#: Предел длины пути: Windows с длинными путями не везде включён, а `app/<версия>`
#: добавляет к папке ещё десяток символов и файлы в две сотни.
MAX_ROOT_LENGTH = 180


def validate_install_dir(path) -> str:
    """Можно ли ставить программу в эту папку. Пустая строка — можно.

    Проверяем то, что действительно мешает: корень диска и системные папки
    (там нужны права администратора, а обновления пишут в `app/`), слишком
    длинный путь и отсутствие прав на запись. Папку пользователя вроде
    `D:\\Games\\ColonialHelper` установщик принимает: именно этого и просили.
    """
    folder = Path(path).expanduser()
    if not str(folder).strip():
        return tr("Выберите папку для установки")
    if not folder.is_absolute():
        return tr("Нужен полный путь к папке установки")
    reason = uninstall.protected_reason(folder)
    if reason:
        return reason
    if len(str(folder)) > MAX_ROOT_LENGTH:
        return tr("Путь длиннее {limit} символов — Windows не откроет часть файлов",
                  limit=MAX_ROOT_LENGTH)
    candidate = folder
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    if not candidate.is_dir():
        return tr("Папка {path} недоступна", path=str(folder))
    if not os.access(candidate, os.W_OK):
        return tr("Нет прав на запись в {path} — выберите другую папку",
                  path=str(candidate))
    return ""


def payload_executable() -> Path:
    """Find the embedded launcher in a PyInstaller Setup or source checkout."""
    base = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "_MEIPASS", "") else Path(__file__).resolve().parent
    candidate = base / PAYLOAD_DIR / EXECUTABLE
    if candidate.is_file():
        return candidate
    return base / "dist" / EXECUTABLE


def has_existing_install(install_root: Optional[Path] = None) -> bool:
    """Recognize a full install and interrupted installs missing the launcher."""
    root = Path(install_root or bundle.install_root()).expanduser()
    return (
        (root / EXECUTABLE).is_file()
        or bundle.state_path(root).is_file()
        or bundle.versions_dir(root).is_dir()
    )


def install_root_default() -> Path:
    """Куда ставить по умолчанию: прошлая папка, иначе системная папка Helper.

    Программу можно поставить куда угодно, поэтому «прошлую папку» Setup берёт
    из записи в «Программах и компонентах», а не угадывает по `%LOCALAPPDATA%`.
    """
    return uninstall.registered_install_root() or bundle.install_root()


def create_shortcut(shortcut_path: Path, target_path: Path) -> None:
    """Create a Windows .lnk with the inbox Windows Script Host (no PowerShell)."""
    shortcut_path = Path(shortcut_path)
    target_path = Path(target_path)
    shortcut_path.parent.mkdir(parents=True, exist_ok=True)
    script = (
        'Set shell = CreateObject("WScript.Shell")\r\n'
        'Set shortcut = shell.CreateShortcut(WScript.Arguments(0))\r\n'
        'shortcut.TargetPath = WScript.Arguments(1)\r\n'
        'shortcut.WorkingDirectory = WScript.Arguments(2)\r\n'
        'shortcut.IconLocation = WScript.Arguments(1) & ",0"\r\n'
        'shortcut.Description = "ED Ring Colony Colonial Helper"\r\n'
        'shortcut.Save\r\n'
    )
    script_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="ascii", suffix=".vbs", delete=False,
        ) as handle:
            handle.write(script)
            script_path = Path(handle.name)
        command = [
            "cscript.exe", "//NoLogo", "//B", str(script_path),
            str(shortcut_path), str(target_path), str(target_path.parent),
        ]
        run_options = {
            "capture_output": True, "text": True, "errors": "replace",
            "timeout": 12, "check": False,
        }
        if sys.platform.startswith("win"):
            run_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            completed = subprocess.run(command, **run_options)
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                tr("Windows Script Host не создал ярлык {name} за 12 секунд.",
                   name=shortcut_path.name)
            ) from None
        if completed.returncode:
            detail = (completed.stderr or completed.stdout
                      or tr("Windows Script Host вернул ошибку")).strip()
            raise RuntimeError(tr("Не удалось создать ярлык {name}: {detail}",
                                  name=shortcut_path.name, detail=detail[:300]))
    finally:
        if script_path is not None:
            try:
                script_path.unlink()
            except OSError:
                pass


def _launch(executable: Path, install_root: Path, spawn=None,
            repair: bool = False, reinstall: bool = False):
    popen = spawn or subprocess.Popen
    env = os.environ.copy()
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    env[bundle.HOME_ENV] = str(install_root)
    kwargs = {"cwd": str(install_root), "env": env, "close_fds": True}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    args = [str(executable)]
    if repair:
        args.append("--repair")
    elif reinstall:
        args.append("--reinstall")
    return popen(args, **kwargs)


def install_launcher(source_exe: Path, install_root: Optional[Path] = None,
                     start_menu_dir: Optional[Path] = None,
                     desktop_dir: Optional[Path] = None,
                     create_links: bool = True, desktop_shortcut: bool = False,
                     launch: bool = True, repair: bool = False,
                     reinstall: bool = False,
                     shortcut_writer: Optional[Callable] = None,
                     process_launcher: Optional[Callable] = None,
                     register: bool = True) -> Dict[str, object]:
    """Install/repair the launcher, add shortcuts, and optionally start it.

    Repair fetches a clean current application bundle; reinstall uses the bundle
    embedded in Setup. Both preserve user settings and credentials.

    Shortcut errors are returned as warnings: the installed program remains
    usable from its install directory even if a Windows policy blocks .lnk creation.
    """
    source = Path(source_exe)
    if not source.is_file() or source.stat().st_size <= 0:
        raise FileNotFoundError(tr("Не найден файл лаунчера: {path}", path=source))
    root = Path(install_root or bundle.install_root()).expanduser()
    # Единственная точка проверки: и окно, и `--install-dir`, и будущие вызовы
    # получают один и тот же отказ на корень диска и системные папки.
    reason = validate_install_dir(root)
    if reason:
        raise ValueError(reason)
    root.mkdir(parents=True, exist_ok=True)
    target = root / EXECUTABLE
    temporary = target.with_name(f".{EXECUTABLE}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(source, temporary)
        if temporary.stat().st_size != source.stat().st_size:
            raise OSError(tr("Размер скопированного лаунчера не совпадает с оригиналом"))
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

    # Маркер рядом с exe: по нему лаунчер находит выбранную папку, а удаление
    # понимает, что это именно установка Helper, а не случайная папка.
    try:
        bundle.write_install_marker(root, silent=True)
    except OSError:
        pass

    warnings: List[str] = []
    shortcuts: List[Path] = []
    if create_links:
        writer = shortcut_writer or create_shortcut
        menu = Path(start_menu_dir) if start_menu_dir else (
            Path(os.environ.get("APPDATA", Path.home()))
            / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "ED Ring Colony"
        )
        shortcut_targets = [(menu / "Colonial Helper.lnk", target)]
        if desktop_shortcut:
            desktop = Path(desktop_dir) if desktop_dir else Path.home() / "Desktop"
            shortcut_targets.append((desktop / "Colonial Helper.lnk", target))
        for link, executable in shortcut_targets:
            try:
                writer(link, executable)
                shortcuts.append(link)
            except Exception as exc:
                warnings.append(str(exc))

    registered: List[str] = []
    if register:
        registered = uninstall.register_uninstall(root, target)
        warnings += registered

    process = _launch(
        target, root, process_launcher, repair=repair, reinstall=reinstall,
    ) if launch else None
    return {"executable": target, "shortcuts": shortcuts, "warnings": warnings,
            "process": process, "install_root": root,
            "registered": not registered}


def _argument(args: List[str], name: str) -> str:
    """Значение флага `--name значение` (без падения на неполном списке)."""
    try:
        index = args.index(name)
    except ValueError:
        return ""
    return args[index + 1] if index + 1 < len(args) else ""


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--uninstall" in args:
        # Удаление живёт отдельным модулем, но вызывается и из Setup: у
        # пользователя может быть только установщик, а Helper уже нет.
        return uninstall.main(args)
    source = payload_executable()
    install_root = _argument(args, "--install-dir")
    if "--silent" in args:
        try:
            root = Path(install_root).expanduser() if install_root else None
            if root is not None:
                reason = validate_install_dir(root)
                if reason:
                    print(reason, file=sys.stderr)
                    return 1
            install_launcher(source, install_root=root, create_links=True,
                             desktop_shortcut="--desktop" in args,
                             launch="--no-launch" not in args)
            return 0
        except Exception as exc:
            print(tr("Не удалось установить Colonial Helper: {error}", error=exc),
                  file=sys.stderr)
            return 1
    try:
        from installer_window import SetupWindow
        from ui_qt import ensure_app

        app = ensure_app()
        if install_root:
            window = SetupWindow(source, install_root=Path(install_root).expanduser())
        else:
            window = SetupWindow(source)
        window.show()
        app.exec()
        return 0
    except BaseException as exc:
        from ui_qt import report_startup_error

        report_startup_error(exc, title=tr("Не удалось открыть установщик Colonial Helper"))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
