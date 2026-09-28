"""Сборка базовой сборки (лаунчера) Colonial Helper.

Важное отличие от прежней схемы: в exe попадает **не программа, а рантайм**.
Внутри — Python, tkinter, ttkbootstrap, requests и лаунчер (`launcher.py`),
плюс встроенная копия пакета кода на случай первого запуска. Сами модули
программы живут отдельным пакетом и обновляются по сети пофайлово, поэтому
этот exe пересобирается редко: при смене версии Python, новой библиотеке в
`requirements.txt` или правке самого лаунчера.

Ключевая тонкость: модули программы **намеренно не замораживаются** в exe.
Замороженный модуль ищется раньше пути на диске (FrozenImporter стоит в
`sys.meta_path` перед обычными импортёрами), и обновлённый `colonial_helper.py`
из пакета никогда бы не запустился — программа молча работала бы на коде
полугодовой давности. Поэтому внутрь кладём только их зависимости: список
собирается автоматически разбором `import` во всех модулях пакета.

Запуск:  python uploader/build_exe.py
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import build_bundle  # noqa: E402

#: Куда кладётся встроенная копия пакета перед сборкой.
EMBED_DIR = HERE / "build" / "app_bundle"
#: Куда build_bundle складывает манифест и архив.
BUNDLE_OUT = HERE / "dist" / "bundle"

#: Пакеты, которые PyInstaller должен забрать целиком (данные + подмодули).
COLLECT_PACKAGES = ("ttkbootstrap",)

#: Библиотеки, которые обязаны быть в сборке, даже если импортируются лениво.
ALWAYS_INCLUDE = (
    "requests", "pyperclip", "tkinter", "tkinter.ttk", "tkinter.filedialog",
    "tkinter.messagebox", "tkinter.simpledialog", "tkinter.font",
    "tkinter.colorchooser", "tkinter.scrolledtext",
    "ttkbootstrap", "ttkbootstrap.style", "ttkbootstrap.themes",
    "ttkbootstrap.localization", "ttkbootstrap.widgets", "ttkbootstrap.dialogs",
    "ttkbootstrap.scrolled", "ttkbootstrap.tableview", "ttkbootstrap.toast",
    "ttkbootstrap.tooltip", "ttkbootstrap.utility", "ttkbootstrap.validation",
    "ttkbootstrap.window",
    # Стандартная библиотека, которую легко потерять при анализе одного
    # лаунчера: дальше список дополняется автоматически.
    "webbrowser", "ctypes", "ctypes.wintypes", "csv", "sqlite3", "queue",
    "secrets", "hmac", "base64", "zipfile", "shutil", "tempfile", "difflib",
    "statistics", "unicodedata", "http.server", "urllib.parse", "urllib.request",
    "concurrent.futures", "email.utils", "logging.handlers", "uuid", "socket",
    "ssl", "subprocess", "webbrowser",
)


def collect_imports(source: Path, own: set[str]) -> list[str]:
    """Все внешние модули, которые импортируют файлы пакета.

    Разбираем синтаксическое дерево, а не текст: так находятся и импорты
    внутри функций (`import requests` в обработчике), которые PyInstaller
    без анализа этих файлов не увидит вовсе.
    """
    found: set[str] = set()
    for path in sorted(source.glob("*.py")):
        if path.name in build_bundle.EXCLUDE:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            print(f"  ! не разобрал {path.name}: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    found.add(node.module)
    # Свои модули приезжают пакетом — замораживать их нельзя.
    return sorted(name for name in found if name.split(".")[0] not in own)


def main() -> int:
    import PyInstaller.__main__

    own = {path.stem for path in HERE.glob("*.py")}

    # 1. Пакет кода: манифест + архив + встроенная копия для exe.
    #    Подпись подхватывается из UPLOADER_SIGN_KEY, если он задан.
    version = build_bundle.bundle_version(HERE)
    build_bundle.main([
        "--source", str(HERE),
        "--out", str(BUNDLE_OUT),
        "--embed", str(EMBED_DIR),
        "--channel", os.environ.get("UPLOADER_CHANNEL", "") or "stable",
        "--branch", os.environ.get("GITHUB_REF_NAME", ""),
    ])

    hidden = sorted(set(collect_imports(HERE, own)) | set(ALWAYS_INCLUDE))
    print(f"Зависимостей в сборку: {len(hidden)}")

    icon_path = HERE / "colonial_helper.ico"
    args = [
        str(HERE / "launcher.py"),
        "--onefile",
        "--windowed",
        "--name", "ColonialHelper",
        "--distpath", str(HERE / "dist"),
        "--workpath", str(HERE / "build" / "pyinstaller"),
        "--specpath", str(HERE / "build"),
        # Встроенная копия пакета: из неё программа стартует до первого
        # обновления (и к ней же откатывается, если всё сломалось).
        "--add-data", f"{EMBED_DIR}{os.pathsep}app_bundle",
        # Лаунчеру нужны ровно три своих модуля; остальное приезжает пакетом.
        "--hidden-import", "bundle",
        "--hidden-import", "bundle_updater",
        "--hidden-import", "site_config",
    ]
    for name in hidden:
        args += ["--hidden-import", name]
    for package in COLLECT_PACKAGES:
        args += ["--collect-data", package, "--collect-submodules", package]
    if icon_path.exists():
        args.append(f"--icon={icon_path}")

    print(f"Сборка лаунчера Colonial Helper (пакет {version})")
    PyInstaller.__main__.run(args)

    exe = HERE / "dist" / ("ColonialHelper.exe" if sys.platform.startswith("win") else "ColonialHelper")
    if exe.exists():
        print(f"Готово: {exe} ({exe.stat().st_size / 1048576:.1f} МиБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
