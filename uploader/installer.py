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

APP_NAME = "ED Ring Colony — Colonial Helper"
EXECUTABLE = "ColonialHelper.exe"
PAYLOAD_DIR = "payload"


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
                     process_launcher: Optional[Callable] = None) -> Dict[str, object]:
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

    process = _launch(
        target, root, process_launcher, repair=repair, reinstall=reinstall,
    ) if launch else None
    return {"executable": target, "shortcuts": shortcuts, "warnings": warnings,
            "process": process, "install_root": root}


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    source = payload_executable()
    if "--silent" in args:
        try:
            install_launcher(source, create_links=True, desktop_shortcut="--desktop" in args,
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
