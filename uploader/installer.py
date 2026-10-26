"""First-run Windows installer for the Colonial Helper launcher."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional

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
                f"Windows Script Host не создал ярлык {shortcut_path.name} за 12 секунд."
            ) from None
        if completed.returncode:
            detail = (completed.stderr or completed.stdout or "Windows Script Host вернул ошибку").strip()
            raise RuntimeError(f"Не удалось создать ярлык {shortcut_path.name}: {detail[:300]}")
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
        raise FileNotFoundError(f"Не найден файл лаунчера: {source}")
    root = Path(install_root or bundle.install_root()).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    target = root / EXECUTABLE
    temporary = target.with_name(f".{EXECUTABLE}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(source, temporary)
        if temporary.stat().st_size != source.stat().st_size:
            raise OSError("Размер скопированного лаунчера не совпадает с оригиналом")
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


class SetupWindow:
    def __init__(self, root, source: Path):
        import tkinter as tk

        from window_chrome import add_custom_titlebar

        self.tk = tk
        self.root = root
        self.source = source
        self.result = None
        self.desktop = tk.BooleanVar(value=False)
        self.install_root = bundle.install_root()
        self.existing_install = has_existing_install(self.install_root)
        self.window_width = 600 if self.existing_install else 560
        self.window_height = 455 if self.existing_install else 410

        self.root.title("ED Ring Colony — Установка Colonial Helper")
        self.root.geometry(f"{self.window_width}x{self.window_height}")
        self.root.resizable(False, False)
        self.root.configure(bg="#1e2022")
        self.root.protocol("WM_DELETE_WINDOW", self.root.destroy)
        add_custom_titlebar(
            self.root, tk, "УСТАНОВЩИК COLONIAL HELPER",
            close_command=self.root.destroy, allow_maximize=False,
            allow_resize=False,
        )
        self._center()

        panel = tk.Frame(root, bg="#2a2d30")
        panel.pack(fill="both", expand=True, padx=20, pady=18)
        tk.Frame(panel, bg="#e57b28", height=4).pack(fill="x")
        tk.Label(panel, text="ED RING COLONY", bg="#2a2d30", fg="#42b9d4",
                 font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=26, pady=(18, 3))
        tk.Label(panel, text="Colonial Helper", bg="#2a2d30", fg="#f2f3f4",
                 font=("Segoe UI", 24, "bold")).pack(anchor="w", padx=26)
        tk.Label(panel, text="Лаунчер новостей проекта и инструментов командира",
                 bg="#2a2d30", fg="#a1a8ad", font=("Segoe UI", 10)).pack(anchor="w", padx=27, pady=(2, 14))
        if self.existing_install:
            intro = "Найдена установленная программа. Восстановление скачает пакет с сервера (при сбое — из Setup), переустановка использует версию из Setup."
        else:
            intro = "Установка для текущего пользователя"
        tk.Label(panel, text=intro, bg="#2a2d30", fg="#f2f3f4",
                 font=("Segoe UI", 10, "bold"), wraplength=490,
                 justify="left").pack(anchor="w", padx=27)
        tk.Label(panel, text=str(self.install_root), bg="#25282b", fg="#a1a8ad",
                 anchor="w", padx=11, pady=9, font=("Consolas", 9)).pack(fill="x", padx=26, pady=(7, 10))
        tk.Checkbutton(panel, text="Создать ярлык на рабочем столе", variable=self.desktop,
                       bg="#2a2d30", fg="#f2f3f4", selectcolor="#25282b",
                       activebackground="#2a2d30", activeforeground="#f2f3f4",
                       font=("Segoe UI", 9)).pack(anchor="w", padx=25, pady=(0, 9))
        if self.existing_install:
            status_text = "Настройки и пользовательские данные сохранятся при обоих действиях."
        else:
            status_text = "Лаунчер будет установлен и запущен после завершения."
        self.status = tk.Label(panel, text=status_text, bg="#2a2d30", fg="#a1a8ad",
                               anchor="w", justify="left", wraplength=500,
                               font=("Segoe UI", 8))
        self.status.pack(fill="x", padx=27, pady=(0, 10))

        actions = tk.Frame(panel, bg="#2a2d30")
        actions.pack(fill="x", padx=26, side="bottom", pady=(0, 14))
        if self.existing_install:
            self.repair_button = tk.Button(
                actions, text="ВОССТАНОВИТЬ", command=lambda: self.install(repair=True),
                bg="#267f98", fg="#ffffff", activebackground="#3199b4",
                activeforeground="#ffffff", relief="flat", bd=0,
                cursor="hand2", font=("Segoe UI", 9, "bold"), pady=12,
            )
            self.repair_button.pack(side="left", fill="x", expand=True, padx=(0, 6))
            self.install_button = tk.Button(
                actions, text="ПЕРЕУСТАНОВИТЬ", command=lambda: self.install(reinstall=True),
                bg="#e57b28", fg="#ffffff", activebackground="#f18b35",
                activeforeground="#ffffff", relief="flat", bd=0,
                cursor="hand2", font=("Segoe UI", 9, "bold"), pady=12,
            )
            self.install_button.pack(side="left", fill="x", expand=True, padx=(6, 0))
        else:
            self.install_button = tk.Button(
                actions, text="УСТАНОВИТЬ И ЗАПУСТИТЬ", command=self.install,
                bg="#e57b28", fg="#ffffff", activebackground="#f18b35",
                activeforeground="#ffffff", relief="flat", bd=0,
                cursor="hand2", font=("Segoe UI", 10, "bold"), pady=12,
            )
            self.install_button.pack(fill="x")

    def _center(self):
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() - self.window_width) // 2
        y = (self.root.winfo_screenheight() - self.window_height) // 2
        self.root.geometry(
            f"{self.window_width}x{self.window_height}+{max(0, x)}+{max(0, y)}"
        )

    def install(self, repair=False, reinstall=False):
        buttons = [getattr(self, "repair_button", None), self.install_button]
        for button in buttons:
            if button is not None:
                button.configure(state="disabled")
        action = "ВОССТАНОВЛЕНИЕ…" if repair else (
            "ПЕРЕУСТАНОВКА…" if reinstall else "УСТАНОВКА…"
        )
        self.status.configure(text="Копируем лаунчер и создаём ярлыки…", fg="#42b9d4")
        self.install_button.configure(text=action)
        self.root.update_idletasks()
        try:
            result = install_launcher(
                self.source, install_root=self.install_root,
                desktop_shortcut=self.desktop.get(), launch=True,
                repair=repair, reinstall=reinstall,
            )
        except Exception as exc:
            for button in buttons:
                if button is not None:
                    button.configure(state="normal")
            self.install_button.configure(
                text="ПЕРЕУСТАНОВИТЬ" if self.existing_install else "ПОВТОРИТЬ УСТАНОВКУ"
            )
            detail = str(exc)
            if isinstance(exc, PermissionError) or getattr(exc, "winerror", None) in (5, 32):
                detail += " Закройте Colonial Helper, затем повторите установку."
            self.status.configure(text=f"Не удалось установить лаунчер: {detail}", fg="#e27676")
            return
        self.result = result
        if result["warnings"]:
            warning = "; ".join(str(item) for item in result["warnings"])
            self.status.configure(
                text=f"Программа установлена и запускается, но ярлык не создан: {warning}",
                fg="#e2bc65",
            )
            self.root.after(3500, self.root.destroy)
        else:
            self.status.configure(text="Готово. Colonial Helper запускается…", fg="#65c78a")
            self.root.after(800, self.root.destroy)

def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    source = payload_executable()
    if "--silent" in args:
        try:
            install_launcher(source, create_links=True, desktop_shortcut="--desktop" in args,
                             launch="--no-launch" not in args)
            return 0
        except Exception as exc:
            print(f"Не удалось установить Colonial Helper: {exc}", file=sys.stderr)
            return 1
    try:
        import tkinter as tk
        root = tk.Tk()
        SetupWindow(root, source)
        root.mainloop()
        return 0
    except Exception as exc:
        print(f"Не удалось открыть установщик Colonial Helper: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
