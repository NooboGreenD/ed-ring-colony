"""User settings touched by the Launcher: site language and update channel.

The file is shared with Colonial Helper (``~/.colonial_helper.json``), so every
write preserves unrelated keys — tokens, channel, Helper preferences — and
keeps the file private to the current user.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from locale_config import DEFAULT_LOCALE, normalize_locale

DEFAULT_PATH = Path.home() / ".colonial_helper.json"
PRIVATE_MODE = 0o600


def settings_path(path: Optional[Path] = None) -> Path:
    return Path(path) if path is not None else DEFAULT_PATH


def load_settings(path: Optional[Path] = None) -> Dict[str, Any]:
    """Read the shared settings file; a damaged file reads as empty settings."""
    try:
        payload = json.loads(settings_path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def read_site_locale(path: Optional[Path] = None) -> str:
    return normalize_locale(load_settings(path).get("site_locale"))


def save_site_locale(locale: str, path: Optional[Path] = None) -> str:
    """Persist the chosen language together with all existing settings."""
    target = settings_path(path)
    code = normalize_locale(locale)
    payload = load_settings(target)
    payload["site_locale"] = code
    temporary = target.with_suffix(target.suffix + ".tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.chmod(temporary, PRIVATE_MODE)
        except OSError:
            pass
        temporary.replace(target)
    except OSError:
        # A read-only profile must not block launching the program.
        pass
    return code


def update_channel(path: Optional[Path] = None) -> str:
    """Use the Helper's configured channel without changing credentials."""
    channel = str(load_settings(path).get("update_channel") or "stable").strip().lower()
    return channel if channel in ("stable", "beta") else "stable"


def active_version(install_root: Optional[Path] = None) -> str:
    """Version recorded by the bootstrapper, without importing the GUI."""
    import bundle

    try:
        state = bundle.load_state(Path(install_root) if install_root else bundle.install_root())
    except Exception:
        return ""
    return str(state.get("current") or "")


__all__ = [
    "DEFAULT_LOCALE", "DEFAULT_PATH", "active_version", "load_settings",
    "read_site_locale", "save_site_locale", "settings_path", "update_channel",
]
