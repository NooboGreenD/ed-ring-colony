"""Build a one-file Windows installer containing the latest launcher EXE.

Run after ``python uploader/build_exe.py`` on Windows:
    python uploader/build_installer.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAUNCHER_EXE = HERE / "dist" / "ColonialHelper.exe"


def main() -> int:
    if not sys.platform.startswith("win"):
        raise SystemExit("Сборку Windows-установщика запускайте в Windows.")
    if not LAUNCHER_EXE.is_file():
        raise SystemExit(f"Сначала соберите лаунчер: не найден {LAUNCHER_EXE}")

    import PyInstaller.__main__

    icon = HERE / "colonial_helper.ico"
    args = [
        str(HERE / "installer.py"),
        "--onefile",
        "--windowed",
        "--name", "ColonialHelperSetup",
        "--distpath", str(HERE / "dist"),
        "--workpath", str(HERE / "build" / "installer-pyinstaller"),
        "--specpath", str(HERE / "build"),
        "--add-data", f"{LAUNCHER_EXE}{os.pathsep}payload",
        "--hidden-import", "bundle",
        "--hidden-import", "window_chrome",
        "--hidden-import", "tkinter",
        "--hidden-import", "tkinter.messagebox",
    ]
    if icon.is_file():
        args.append(f"--icon={icon}")
    PyInstaller.__main__.run(args)
    output = HERE / "dist" / "ColonialHelperSetup.exe"
    if not output.is_file() or output.stat().st_size <= 0:
        raise SystemExit("PyInstaller не создал ColonialHelperSetup.exe")
    print(f"Готово: {output} ({output.stat().st_size / 1048576:.1f} МиБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
