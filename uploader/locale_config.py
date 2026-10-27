"""Supported site locales shared by Launcher and Colonial Helper."""
from __future__ import annotations

SUPPORTED_LOCALES = {
    "ru": "Русский",
    "en": "English",
    "de": "Deutsch",
    "it": "Italiano",
    "ko": "한국어",
    "zh": "简体中文",
    "ja": "日本語",
}
DEFAULT_LOCALE = "ru"


def normalize_locale(value: object) -> str:
    locale = str(value or DEFAULT_LOCALE).strip().lower().replace("_", "-").split("-", 1)[0]
    return locale if locale in SUPPORTED_LOCALES else DEFAULT_LOCALE


def localized_url(url: str, locale: object) -> str:
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
    parts=urlsplit(str(url));query=dict(parse_qsl(parts.query,keep_blank_values=True))
    query["locale"]=normalize_locale(locale)
    return urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),parts.fragment))
