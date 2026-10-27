"""Desktop start screen entry point for Colonial Helper.

The bootstrapper (`launcher.py`) stays responsible for signed bundles, version
selection and rollback. This module prepares a runnable version and composes the
window: content rules come from :mod:`launcher_content`, settings from
:mod:`launcher_settings`, and the window itself is native Qt in
:mod:`launcher_window`.

The names below are re-exported because older parts of the project (and the
packaging scripts) import them from here.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Optional

import bundle
from launcher_content import (  # noqa: F401 - re-exported public API
    article_blocks,
    article_html,
    article_markup,
    article_url,
    fetch_home_data,
    format_date,
    normalize_home_data,
    plain_text,
)
from launcher_settings import read_site_locale, save_site_locale, update_channel  # noqa: F401

#: Historical name kept for callers that imported the private helper.
_article_url = article_url

__all__ = [
    "COLORS", "article_blocks", "article_html", "article_markup", "article_url",
    "fetch_home_data", "format_date", "normalize_home_data", "plain_text",
    "read_site_locale", "save_site_locale", "show_launcher", "update_channel",
]

COLORS = {
    "bg": "#1e2022",
    "panel": "#2a2d30",
    "panel_alt": "#25282b",
    "line": "#3b4044",
    "text": "#f2f3f4",
    "muted": "#a1a8ad",
    "orange": "#e57b28",
    "cyan": "#42b9d4",
    "green": "#65c78a",
    "red": "#e27676",
}


def _launcher_runtime():
    """Resolve the entry-point module without importing a second frozen copy."""
    module = sys.modules.get("__main__")
    if not hasattr(module, "choose_version"):
        module = sys.modules.get("launcher")
    if module is None or not hasattr(module, "choose_version"):
        raise RuntimeError("Не найден модуль bootstrapper")
    return module


def show_launcher(install_root: Path, embedded_dir: Optional[Path],
                  embedded_manifest: Optional[Dict[str, Any]]) -> bool:
    """Prepare/verify a runnable local version, then show the news dashboard."""
    launcher = _launcher_runtime()
    launcher.configure_tls_ca_bundle(install_root)
    try:
        version = launcher.choose_version(install_root, embedded_dir, embedded_manifest,
                                          record_launch=False)
    except Exception as exc:
        launcher.log(install_root, f"не удалось подготовить версию для стартового экрана: {exc}")
        version = str(bundle.load_state(install_root).get("current") or "")
    try:
        from launcher_window import LauncherWindow
        from ui_qt import ensure_app

        app = ensure_app()
        window = LauncherWindow(install_root, version or "—", update_channel())
        window.show()
        app.exec()
        return window.launch_requested
    except Exception as exc:
        # A damaged/missing GUI runtime must not strand the user outside Helper.
        launcher.log(install_root, f"не удалось открыть стартовый экран: {exc}; запускаем Helper напрямую")
        return True
