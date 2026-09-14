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
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: Статусы, при которых запрос стоит повторить позже.
RETRYABLE_STATUS = frozenset({
    408, 425, 429,                     # таймаут / слишком рано / лимит
    500, 502, 503, 504,                # сервер не справился
    520, 521, 522, 523, 524, 525, 526,  # ошибки Cloudflare
})

#: Признаки HTML-страницы в теле ответа.
HTML_MARKERS = ("<!doctype html", "<html", "<head", "<!--[if", "cloudflare")


def looks_like_html(text: str) -> bool:
    """Похоже ли тело ответа на HTML (а не на JSON/текст ошибки)."""
    head = str(text or "")[:400].lower()
    return any(marker in head for marker in HTML_MARKERS)


def user_agent(app_name: str = "", app_version: str = "") -> str:
    """User-Agent для внешних API.

    EDSM и Inara просят клиента представляться; Cloudflare перед ними
    отклоняет дефолтный `python-requests/…`. Версию подставляем настоящую,
    чтобы по логам сервиса было видно, какая сборка стучится.
    """
    name = str(app_name or "ED Ring Colony Uploader").strip()
    version = str(app_version or "0.0.0").strip()
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
        reason = "сервер вернул HTML-страницу (защита/сбой Cloudflare), а не JSON"
    elif status == 0:
        reason = "нет ответа от сервера"
    elif status in (401, 403):
        reason = "доступ запрещён — проверьте ключ API и имя командира"
    elif status == 404:
        reason = "адрес API не найден (404)"
    elif status == 429:
        reason = "слишком много запросов (429), нужно притормозить"
    elif 500 <= status < 600:
        reason = f"ошибка сервера (HTTP {status})"
    else:
        reason = f"неожиданный ответ (HTTP {status})"

    message = f"{service}: {detail + ' — ' if detail else ''}{reason}"
    if retryable:
        message += "; событие будет повторено"
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
        return "HTML-страница"
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
