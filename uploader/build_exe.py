#!/usr/bin/env python3
"""Сборка ColonialHelper.exe через PyInstaller."""
import subprocess
import sys
import shutil
from pathlib import Path

HERE = Path(__file__).parent
DIST = HERE / "dist"
BUILD = HERE / "build"

# Очистка
for d in (DIST, BUILD):
    if d.exists():
        shutil.rmtree(d)

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--name", "ColonialHelper",
    "--onefile",
    "--windowed",
    "--clean",
    "--noconfirm",
]

# Иконка (только если есть)
ico = HERE / "colonial_helper.ico"
if ico.exists():
    cmd.extend(["--icon", str(ico)])

cmd.append(str(HERE / "colonial_helper.py"))

print("Building ColonialHelper.exe...")
print(" ".join(str(c) for c in cmd))
subprocess.run(cmd, check=True)

print(f"Build complete: {DIST / 'ColonialHelper.exe'}")
