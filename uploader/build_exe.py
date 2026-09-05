import PyInstaller.__main__
import sys
import os
from pathlib import Path

# Определяем путь к иконке
icon_path = Path(__file__).parent / "colonial_helper.ico"
icon_arg = f"--icon={icon_path}" if icon_path.exists() else ""

args = [
    "colonial_helper.py",
    "--onefile",
    "--windowed",
    "--name", "ColonialHelper",
    "--add-data", f"api_client.py{os.pathsep}.",
    "--add-data", f"journal_parser.py{os.pathsep}.",
    "--add-data", f"route_tracker.py{os.pathsep}.",
    "--add-data", f"overlay.py{os.pathsep}.",
    "--add-data", f"ship_tracker.py{os.pathsep}.",
    "--add-data", f"requirements.txt{os.pathsep}.",
    "--hidden-import", "ttkbootstrap",
    "--hidden-import", "requests",
    "--hidden-import", "pyperclip",
    "--hidden-import", "tkinter",
    "--collect-data", "ttkbootstrap",
    "--collect-submodules", "ttkbootstrap",
    "--hidden-import", "ttkbootstrap.style",
    "--hidden-import", "ttkbootstrap.themes",
    "--hidden-import", "ttkbootstrap.localization",
    "--hidden-import", "ttkbootstrap.widgets",
    "--hidden-import", "ttkbootstrap.dialogs",
    "--hidden-import", "ttkbootstrap.scrolled",
    "--hidden-import", "ttkbootstrap.tableview",
    "--hidden-import", "ttkbootstrap.toast",
    "--hidden-import", "ttkbootstrap.tooltip",
    "--hidden-import", "ttkbootstrap.utility",
    "--hidden-import", "ttkbootstrap.validation",
    "--hidden-import", "ttkbootstrap.window",
]

if icon_arg:
    args.append(icon_arg)

PyInstaller.__main__.run(args)
sys.exit(0)
