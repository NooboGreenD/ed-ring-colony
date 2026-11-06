"""Разбор «плохих» ответов внешних API: без сырого HTML в логе.

Зачем
-----

EDSM и Inara стоят за Cloudflare. Когда сервис недоступен, перегружен или
отклоняет клиент, в ответ приходит **HTML-страница** (`<!DOCTYPE html> …
<!--[if lt IE 7]> …`), а не JSON. Раньше клиенты внешних API клали в `error`
кусок `response.text`, и в лог пользователя уезжали сотни символов разметки:

    EDSM: <!DOCTYPE html>
    <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->

Понять из этого ничего нельзя, а на истории такое печатается на каждое
событие. Здесь ответ классифицируется в короткое человекочитаемое сообщение
плюс признак «можно повторить» — по нему клиент решает, повторять ли запрос,
а диспетчер — не засорять ли лог.

Отдельно: у запросов должен быть осмысленный `User-Agent`. Cloudflare
регулярно отклоняет дефолтный `python-requests/<версия>`, и именно это
выглядит как «сервис сломался», хотя дело в заголовке (см. `user_agent()`).

И третье, из-за чего обновления выглядели «недоступными»: `requests`
кодирует **заголовки** в latin-1. Любая «—» (U+2014) или кириллица в
значении заголовка роняет запрос с `UnicodeEncodeError` ещё до отправки,
а вызывающий код видит обычное исключение и сообщает «сервер недоступен».
Поэтому всё, что уходит в заголовок, проходит через `header_safe()`.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from i18n import tr

#: Статусы, при которых запрос стоит повторить позже.
RETRYABLE_STATUS = frozenset({
    408, 425, 429,                     # таймаут / слишком рано / лимит
    500, 502, 503, 504,                # сервер не справился
    520, 521, 522, 523, 524, 525, 526,  # ошибки Cloudflare
})

#: Признаки HTML-страницы в теле ответа.
HTML_MARKERS = ("<!doctype html", "<html", "<head", "<!--[if", "cloudflare")

#: Типографские знаки, которые Windows-текст приносит в заголовки: их
#: заменяем на ASCII, чтобы запрос не падал на кодировке в latin-1.
_HEADER_PUNCTUATION = (
    ("\u2010", "-"), ("\u2011", "-"), ("\u2012", "-"), ("\u2013", "-"),
    ("\u2014", "-"), ("\u2015", "-"), ("\u2212", "-"), ("\u00ad", ""),
    ("\u2018", "'"), ("\u2019", "'"), ("\u201a", ","), ("\u2032", "'"),
    ("\u201c", '"'), ("\u201d", '"'), ("\u201e", '"'), ("\u2033", '"'),
    ("\u00ab", '"'), ("\u00bb", '"'), ("\u2026", "..."),
    ("\u00a0", " "), ("\u2009", " "), ("\u202f", " "), ("\u200b", ""),
)


def looks_like_html(text: str) -> bool:
    """Похоже ли тело ответа на HTML (а не на JSON/текст ошибки)."""
    head = str(text or "")[:400].lower()
    return any(marker in head for marker in HTML_MARKERS)


def header_safe(value: Any, fallback: str = "") -> str:
    """Значение HTTP-заголовка, которое переживает кодировку latin-1.

    `requests` (и `http.client`) кодируют заголовки в latin-1: попавшая туда
    «—» или кириллица даёт `UnicodeEncodeError: 'latin-1' codec can't encode
    character ...` **до** отправки запроса, а выше это выглядит как сетевая
    ошибка. Типографские знаки заменяем на ASCII-аналоги, всё остальное
    не-ASCII выбрасываем; пустой результат заменяем на `fallback`.
    """
    text = str(value or "")
    for source, target in _HEADER_PUNCTUATION:
        text = text.replace(source, target)
    text = text.encode("latin-1", "ignore").decode("latin-1")
    text = "".join(ch for ch in text if 32 <= ord(ch) < 127)
    text = " ".join(text.split())
    return text or fallback


def header_token(value: Any, fallback: str = "") -> str:
    """Короткий токен для заголовка (`"—"` → `fallback`, кириллица → пусто)."""
    text = header_safe(value)
    token = "".join(ch for ch in text if ch.isalnum() or ch in "._+-")
    token = token.strip("._+-")[:40]
    return token if any(ch.isalnum() for ch in token) else fallback


def user_agent(app_name: str = "", app_version: str = "") -> str:
    """User-Agent для внешних API.

    EDSM и Inara просят клиента представляться; Cloudflare перед ними
    отклоняет дефолтный `python-requests/…`. Версию подставляем настоящую,
    чтобы по логам сервиса было видно, какая сборка стучится.

    Имя приложения — «ED Ring Colony — Colonial Helper» с длинным тире:
    в заголовке тире латин-1 не переживает, поэтому здесь ASCII-вариант.
    """
    name = header_safe(app_name, "ED Ring Colony Uploader")
    version = header_token(app_version, "0.0.0")
    return (
        f"{name}/{version} "
        "(Elite Dangerous journal uploader; "
        "https://github.com/NooboGreenD/ed-ring-colony)"
    )


def _status_of(response) -> int:
    try:
        return int(getattr(response, "status_code", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _body_of(response, limit: int = 400) -> str:
    try:
        return str(getattr(response, "text", "") or "")[:limit]
    except Exception:
        return ""


def describe_bad_response(service: str, response,
                          detail: str = "") -> Dict[str, Any]:
    """Короткое описание неудачного ответа внешнего сервиса.

    Возвращает `{"ok": False, "status", "retryable", "error"}`. Сырое тело в
    `error` не попадает — только если это короткий не-HTML текст.
    """
    status = _status_of(response)
    body = _body_of(response)
    html = looks_like_html(body)
    retryable = status in RETRYABLE_STATUS or html or status == 0

    if html:
        reason = tr("сервер вернул HTML-страницу (защита/сбой Cloudflare), а не JSON")
    elif status == 0:
        reason = tr("нет ответа от сервера")
    elif status in (401, 403):
        reason = tr("доступ запрещён — проверьте ключ API и имя командира")
    elif status == 404:
        reason = tr("адрес API не найден (404)")
    elif status == 429:
        reason = tr("слишком много запросов (429), нужно притормозить")
    elif 500 <= status < 600:
        reason = tr("ошибка сервера (HTTP {status})", status=status)
    else:
        reason = tr("неожиданный ответ (HTTP {status})", status=status)

    if detail:
        message = tr("{service}: запрос отклонён ({detail}) — {reason}",
                     service=service, detail=detail, reason=reason)
    else:
        message = tr("{service}: запрос отклонён — {reason}",
                     service=service, reason=reason)
    if retryable:
        message = tr("{message} Событие будет повторено.", message=message)
    return {
        "ok": False,
        "status": status,
        "retryable": bool(retryable),
        "html": html,
        "error": message,
    }


def short_body(response, limit: int = 160) -> str:
    """Фрагмент тела для диагностики — HTML при этом не печатаем."""
    body = _body_of(response, limit * 2)
    if looks_like_html(body):
        return tr("HTML-страница")
    return body[:limit].replace("\n", " ").strip()


def apply_client_headers(session, app_name: str = "", app_version: str = "",
                         json_api: bool = True) -> None:
    """Проставить сессии User-Agent и Accept (идемпотентно)."""
    try:
        headers = session.headers
    except AttributeError:
        return
    headers["User-Agent"] = user_agent(app_name, app_version)
    if json_api:
        headers["Accept"] = "application/json"
