"""Content model behind the Launcher feed: fetching, normalizing and formatting.

Nothing here touches Qt, so the parsing rules stay testable without a display
server. The window layer only turns these blocks into widgets.
"""
from __future__ import annotations

import html
import re
from datetime import datetime
from typing import Any, Dict, List, Tuple

from i18n import tr
from urllib.parse import quote

import requests

from locale_config import DEFAULT_LOCALE, normalize_locale
from site_config import DEFAULT_SITE_URL

#: Colour tokens duplicated here as plain strings: this module stays Qt-free.
TEXT = "#f2f3f4"
MUTED = "#a1a8ad"
CYAN = "#42b9d4"
BG = "#1e2022"

#: Longest body preview shown in a feed card, mirrored from the first design.
MAX_BODY_CHARS = 900

Segment = Tuple[str, Tuple[str, ...]]
Block = Tuple[str, List[Segment]]


def normalize_home_data(payload: Any) -> Dict[str, List[Dict[str, str]]]:
    """Reduce the public site response to safe, displayable article fields."""
    if not isinstance(payload, dict):
        raise ValueError(tr("Ответ сайта имеет неверный формат"))
    output: Dict[str, List[Dict[str, str]]] = {}
    for key in ("news", "galnet"):
        records = payload.get(key, [])
        if not isinstance(records, list):
            records = []
        cleaned: List[Dict[str, str]] = []
        for record in records[:3]:
            if not isinstance(record, dict):
                continue
            cleaned.append({
                name: str(record.get(name) if record.get(name) is not None else "").strip()
                for name in ("id", "nid", "title", "body", "published_at")
            })
        output[key] = cleaned
    return output


def fetch_home_data(session=None, site_url: str = DEFAULT_SITE_URL,
                    timeout: Tuple[float, float] = (4.0, 8.0),
                    locale: str = DEFAULT_LOCALE,
                    user_agent: str = "ColonialHelperLauncher") -> Dict[str, List[Dict[str, str]]]:
    """Fetch the same localized, public home feed shown on the project site."""
    http = session or requests.Session()
    response = http.get(
        f"{site_url.rstrip('/')}/api/home-data",
        params={"locale": normalize_locale(locale)},
        headers={"Accept": "application/json", "User-Agent": user_agent},
        timeout=timeout,
    )
    response.raise_for_status()
    return normalize_home_data(response.json())


def format_date(value: str) -> str:
    if not value:
        return "НОВОСТИ ПРОЕКТА"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%d.%m.%Y  ·  %H:%M")
    except (ValueError, OverflowError):
        return value[:32]


def article_url(kind: str, article: Dict[str, str]) -> str:
    if kind == "galnet":
        nid = article.get("nid", "")
        return f"{DEFAULT_SITE_URL}/galnet/{quote(nid, safe='')}" if nid else f"{DEFAULT_SITE_URL}/galnet"
    return f"{DEFAULT_SITE_URL}/news/{quote(article.get('id', ''), safe='')}"


def article_markup(value: str) -> str:
    """Convert safe CMS HTML/Markdown fragments into a small Markdown subset."""
    text = html.unescape(str(value or ""))
    text = re.sub(r"<\s*script\b[^>]*>.*?</\s*script\s*>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\s*style\b[^>]*>.*?</\s*style\s*>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*/?\s*(p|div|section|article)\b[^>]*>", "\n\n", text,
                  flags=re.IGNORECASE)
    text = re.sub(r"<\s*h[1-6]\b[^>]*>", "\n\n# ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*h[1-6]\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*li\b[^>]*>", "\n- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*li\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*(strong|b)\b[^>]*>", "**", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(strong|b)\s*>", "**", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*(em|i)\b[^>]*>", "*", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(em|i)\s*>", "*", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*code\b[^>]*>", "`", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*code\s*>", "`", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*blockquote\b[^>]*>", "\n> ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*blockquote\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]*>", "", text)
    text = text.replace("\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    normalized: List[str] = []
    blank = False
    for line in lines:
        if not line:
            if normalized and not blank:
                normalized.append("")
            blank = True
            continue
        normalized.append(line)
        blank = False
    return "\n".join(normalized).strip()


_INLINE_MARKUP = re.compile(
    r"(?P<link>\[([^\]]+)\]\((?:https?://|/)[^)]*\))"
    r"|(?P<strong>\*\*.+?\*\*|__.+?__)"
    r"|(?P<code>`[^`]+`)"
    r"|(?P<em>(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))"
)


def _inline_segments(line: str) -> List[Segment]:
    segments: List[Segment] = []
    cursor = 0
    for match in _INLINE_MARKUP.finditer(line):
        if match.start() > cursor:
            segments.append((line[cursor:match.start()], ()))
        token = match.group(0)
        if match.lastgroup == "link":
            segments.append((match.group(2), ("link",)))
        elif match.lastgroup == "strong":
            segments.append((token[2:-2], ("strong",)))
        elif match.lastgroup == "code":
            segments.append((token[1:-1], ("code",)))
        else:
            segments.append((token[1:-1], ("em",)))
        cursor = match.end()
    if cursor < len(line):
        segments.append((line[cursor:], ()))
    return segments


def article_blocks(value: str) -> List[Block]:
    """Parse headings, paragraphs, lists and inline emphasis for the feed."""
    text = article_markup(value)
    blocks: List[Block] = []
    paragraph: List[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append(("paragraph", _inline_segments(" ".join(paragraph))))
            paragraph.clear()

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        ordered = re.match(r"^(\d+)[.)]\s+(.+)$", stripped)
        quote_line = re.match(r"^>\s?(.*)$", stripped)
        if heading or bullet or ordered or quote_line:
            flush_paragraph()
            if heading:
                blocks.append(("heading", _inline_segments(heading.group(2))))
            elif bullet:
                blocks.append(("bullet", _inline_segments(bullet.group(1))))
            elif ordered:
                blocks.append((f"ordered:{ordered.group(1)}", _inline_segments(ordered.group(2))))
            else:
                blocks.append(("quote", _inline_segments(quote_line.group(1))))
        else:
            paragraph.append(stripped)
    flush_paragraph()
    return blocks


def plain_text(value: str) -> str:
    """Readable plain-text preview used by tests and non-rich-text fallbacks."""
    lines = []
    for kind, segments in article_blocks(value):
        text = "".join(segment for segment, _tags in segments)
        if kind == "bullet":
            text = f"• {text}"
        elif kind.startswith("ordered:"):
            text = f"{kind.split(':', 1)[1]}. {text}"
        elif kind == "quote":
            text = f"“{text}”"
        lines.append(text)
    return "\n".join(lines)


_INLINE_HTML = {
    "strong": ('<b>', "</b>"),
    "em": ('<i>', "</i>"),
    "code": (f'<span style="font-family:Consolas,monospace;color:{CYAN};">', "</span>"),
    "link": (f'<span style="color:{CYAN};text-decoration:underline;">', "</span>"),
}


def article_html(value: str, *, max_chars: int = MAX_BODY_CHARS) -> str:
    """Render the parsed blocks as a small HTML fragment for a QLabel."""
    blocks = article_blocks(value)
    if not blocks:
        return ""
    readable = plain_text(value)
    if len(readable) > max_chars:
        readable = readable[:max_chars - 3].rsplit(" ", 1)[0] + "…"
        blocks = [("paragraph", [(readable, ())])]

    def render(segments: List[Segment]) -> str:
        parts = []
        for segment, tags in segments:
            piece = html.escape(segment)
            for tag in ("strong", "em", "code", "link"):
                if tag in tags:
                    opening, closing = _INLINE_HTML[tag]
                    piece = f"{opening}{piece}{closing}"
            parts.append(piece)
        return "".join(parts)

    fragments: List[str] = []
    for kind, segments in blocks:
        if kind == "heading":
            fragments.append(
                f'<div style="font-weight:700;color:{TEXT};margin:8px 0 4px;">{render(segments)}</div>')
        elif kind == "bullet":
            fragments.append(f'<div style="margin:0 0 3px;">•&nbsp;&nbsp;{render(segments)}</div>')
        elif kind.startswith("ordered:"):
            number = kind.split(":", 1)[1]
            fragments.append(
                f'<div style="margin:0 0 3px;">{number}.&nbsp;&nbsp;{render(segments)}</div>')
        elif kind == "quote":
            fragments.append(
                f'<div style="color:{MUTED};margin:0 0 4px 14px;">{render(segments)}</div>')
        else:
            fragments.append(f'<div style="margin:0 0 4px;">{render(segments)}</div>')
    return "".join(fragments)
