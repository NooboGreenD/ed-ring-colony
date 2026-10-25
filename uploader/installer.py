"""First-run Windows installer for the Colonial Helper launcher."""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
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


def _ps_quote(value: str) -> str:
    encoded = base64.b64encode(str(value).encode("utf-8")).decode("ascii")
    return f"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))"


def create_shortcut(shortcut_path: Path, target_path: Path) -> None:
    """Create a Windows .lnk through the inbox Windows Script Host COM object."""
    shortcut_path = Path(shortcut_path)
    target_path = Path(target_path)
    shortcut_path.parent.mkdir(parents=True, exist_ok=True)
    command = (
        f"$target={_ps_quote(str(target_path))};"
        f"$link={_ps_quote(str(shortcut_path))};"
        "$shell=New-Object -ComObject WScript.Shell;"
        "$shortcut=$shell.CreateShortcut($link);"
        "$shortcut.TargetPath=$target;"
        "$shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($target);"
        "$shortcut.IconLocation=$target+',0';"
        "$shortcut.Description='ED Ring Colony Colonial Helper';"
        "$shortcut.Save()"
    )
    run_options = {"capture_output": True, "text": True, "timeout": 20, "check": False}
    if sys.platform.startswith("win"):
        run_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    completed = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        **run_options,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "PowerShell вернул ошибку").strip()
        raise RuntimeError(f"Не удалось создать ярлык {shortcut_path.name}: {detail[:500]}")


def _launch(executable: Path, install_root: Path, spawn=None):
    popen = spawn or subprocess.Popen
    env = os.environ.copy()
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    env[bundle.HOME_ENV] = str(install_root)
    kwargs = {"cwd": str(install_root), "env": env, "close_fds": True}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return popen([str(executable)], **kwargs)


def install_launcher(source_exe: Path, install_root: Optional[Path] = None,
                     start_menu_dir: Optional[Path] = None,
                     desktop_dir: Optional[Path] = None,
                     create_links: bool = True, desktop_shortcut: bool = False,
                     launch: bool = True, shortcut_writer: Optional[Callable] = None,
                     process_launcher: Optional[Callable] = None) -> Dict[str, object]:
    """Atomically install the launcher, add shortcuts, and optionally start it.

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

    process = _launch(target, root, process_launcher) if launch else None
    return {"executable": target, "shortcuts": shortcuts, "warnings": warnings,
            "process": process, "install_root": root}


class SetupWindow:
    def __init__(self, root, source: Path):
        import tkinter as tk

        self.tk = tk
        self.root = root
        self.source = source
        self.result = None
        self.desktop = tk.BooleanVar(value=False)
        self.root.title("ED Ring Colony — Установка Colonial Helper")
        self.root.geometry("560x390")
        self.root.resizable(False, False)
        self.root.configure(bg="#1e2022")
        self.root.protocol("WM_DELETE_WINDOW", self.root.destroy)
        self._center()

        panel = tk.Frame(root, bg="#2a2d30")
        panel.pack(fill="both", expand=True, padx=20, pady=20)
        tk.Frame(panel, bg="#e57b28", height=4).pack(fill="x")
        tk.Label(panel, text="ED RING COLONY", bg="#2a2d30", fg="#42b9d4",
                 font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=26, pady=(24, 3))
        tk.Label(panel, text="Colonial Helper", bg="#2a2d30", fg="#f2f3f4",
                 font=("Segoe UI", 24, "bold")).pack(anchor="w", padx=26)
        tk.Label(panel, text="Лаунчер новостей проекта и инструментов командира",
                 bg="#2a2d30", fg="#a1a8ad", font=("Segoe UI", 10)).pack(anchor="w", padx=27, pady=(2, 18))
        tk.Label(panel, text="Установка для текущего пользователя",
                 bg="#2a2d30", fg="#f2f3f4", font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=27)
        target = bundle.install_root()
        tk.Label(panel, text=str(target), bg="#25282b", fg="#a1a8ad",
                 anchor="w", padx=11, pady=9, font=("Consolas", 9)).pack(fill="x", padx=26, pady=(7, 11))
        tk.Checkbutton(panel, text="Создать ярлык на рабочем столе", variable=self.desktop,
                       bg="#2a2d30", fg="#f2f3f4", selectcolor="#25282b",
                       activebackground="#2a2d30", activeforeground="#f2f3f4",
                       font=("Segoe UI", 9)).pack(anchor="w", padx=25, pady=(0, 15))
        self.status = tk.Label(panel, text="Приложение будет установлено и запущено после установки.",
                               bg="#2a2d30", fg="#a1a8ad", anchor="w", justify="left",
                               wraplength=490, font=("Segoe UI", 8))
        self.status.pack(fill="x", padx=27, pady=(0, 12))
        self.install_button = tk.Button(panel, text="УСТАНОВИТЬ И ЗАПУСТИТЬ", command=self.install,
                                        bg="#e57b28", fg="#ffffff", activebackground="#f18b35",
                                        activeforeground="#ffffff", relief="flat", bd=0,
                                        cursor="hand2", font=("Segoe UI", 10, "bold"), pady=12)
        self.install_button.pack(fill="x", padx=26, side="bottom", pady=(0, 22))

    def _center(self):
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() - 560) // 2
        y = (self.root.winfo_screenheight() - 390) // 2
        self.root.geometry(f"560x390+{max(0, x)}+{max(0, y)}")

    def install(self):
        from tkinter import messagebox
        self.install_button.configure(state="disabled", text="УСТАНОВКА…")
        self.status.configure(text="Копируем лаунчер и создаём ярлыки…", fg="#42b9d4")
        self.root.update_idletasks()
        try:
            result = install_launcher(self.source, desktop_shortcut=self.desktop.get(), launch=True)
        except Exception as exc:
            self.install_button.configure(state="normal", text="ПОВТОРИТЬ УСТАНОВКУ")
            self.status.configure(text=f"Не удалось установить лаунчер: {exc}", fg="#e27676")
            return
        self.result = result
        if result["warnings"]:
            messagebox.showwarning("Colonial Helper установлен", "Лаунчер установлен, но один из ярлыков не создан:\n\n" + "\n".join(result["warnings"]))
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
