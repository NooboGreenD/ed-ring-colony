"""Semantic theme tokens. Premium-market themes can register a token set later."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping
import re


@dataclass(frozen=True)
class ThemeTokens:
    background: str = "#1e2022"
    surface: str = "#2a2d30"
    surface_alt: str = "#25282b"
    line: str = "#3b4044"
    text: str = "#f2f3f4"
    muted: str = "#a1a8ad"
    accent: str = "#e57b28"
    accent_hover: str = "#f18b35"
    cyan: str = "#42b9d4"
    success: str = "#65c78a"
    danger: str = "#e27676"


_BUILTIN = {"default-dark": ThemeTokens()}


def theme_tokens(theme_id: str = "default-dark", purchased: Mapping[str, Mapping[str, str]] | None = None) -> ThemeTokens:
    """Resolve a theme id; market themes are accepted only from supplied owned inventory."""
    if purchased and theme_id in purchased:
        base = _BUILTIN["default-dark"]
        allowed = set(ThemeTokens.__dataclass_fields__)
        values = {k: str(v) for k,v in purchased[theme_id].items()
                  if k in allowed and isinstance(v,str) and re.fullmatch(r"#[0-9a-fA-F]{6}",v)}
        try:
            return ThemeTokens(**{**base.__dict__, **values})
        except (TypeError, ValueError):
            pass
    return _BUILTIN.get(theme_id, _BUILTIN["default-dark"])
