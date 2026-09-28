"""Frontier Companion API (CAPI) из Colonial Helper — без Shared Key от FDEV.

Зачем этот модуль
-----------------

Досье пилота на сайте заполняется из CAPI: баланс, ранги, текущий корабль и
система, счётчики экзобиологии. Получить их может только тот, кого командир
авторизовал у Frontier. Сайт делал это сам, но для обмена кода на токен ему
требовался `client_secret` («Shared Key» из Developer Zone), который Frontier
выдаёт по заявке и иногда не выдаёт вовсе.

Решение — поток **PKCE**, для которого секрет не нужен: доказательством служит
`code_verifier`, известный только тому, кто начал авторизацию. Именно так
работают десктопные инструменты сообщества (EDMC, EDDI). Нужен только Client ID,
а его можно создать самостоятельно за минуту в Developer Zone
(https://user.frontierstore.net → «CREATE CLIENT»); по умолчанию используется
client_id приложения «ED Ring Colony», зарегистрированного проектом.

Как это устроено здесь
----------------------

1. `CompanionAuth.authorize()` открывает браузер на
   `https://auth.frontierstore.net/auth` с `code_challenge` (S256) и
   `redirect_uri` на локальный порт `http://127.0.0.1:<port>/`.
2. Локальный `http.server` ловит `?code=…&state=…`, отдаёт страницу «можно
   закрыть» и закрывается.
3. Код обменивается на токены POST'ом на `https://auth.frontierstore.net/token`
   с `code_verifier` — БЕЗ `client_secret`.
4. Токены хранятся локально (`capi_tokens.json` рядом с настройками) и
   обновляются refresh-токеном. Refresh живёт не дольше 25 дней с момента
   авторизации, после чего нужна повторная авторизация.
5. `profile_to_stats()` превращает ответ `/profile` в тот же payload, который
   сайт ждёт в `POST /api/cmdr/stats` — дальше работает существующий
   `api_client.upload_pilot_stats()`.

Три грабли, на которые здесь наступали (и почему код выглядит так)
------------------------------------------------------------------

**1. `audience=frontier` ⇒ CAPI отвечает `HTTP 400`.** Параметр `audience`
говорит Frontier, аккаунт какой платформы авторизуется. Раньше здесь всегда
стояло `frontier` — учётка магазина frontierstore.net. У пилота, купившего игру
в Steam или Epic, такая учётка игрой не владеет: OAuth проходит, токен выдаётся,
`/me` отвечает, а `companion.orerve.net/profile` возвращает
`400 Bad Request: Please Visit the store to purchase Elite: Dangerous`.
Снаружи это и выглядит как «подключение фиктивное». EDMC запрашивает сразу
`audience=frontier,steam,epic` — так же поступаем и мы (`DEFAULT_AUDIENCE`),
а пользователь при желании выбирает платформу явно.

**2. Дефолтный `User-Agent` requests.** Frontier просит третьи стороны
представляться по шаблону `EDCD-[A-Za-z]+-[.0-9]+` (EDCD/FDevIDs →
`Frontier API/README.md`). `python-requests/2.x` под шаблон не подходит.

**3. Разбор `/profile` по «плоским» полям.** CAPI отдаёт `commander.credits`,
`commander.rank.*`, `lastSystem.name`, `lastStarport.name`, `ship.name` +
`ship.shipName`. Старый разбор читал `profile["credits"]`, `profile["rank"]`,
`profile["ship"]` — и досье оставалось пустым даже при успешном ответе.

Модуль не импортирует tkinter и не трогает UI: всё взаимодействие с
пользователем (открытие браузера, сообщения) делает вызывающий код через
колбэки.
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import threading
import time
import webbrowser
from typing import Callable, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

try:
    import requests
except ImportError:  # pragma: no cover - окружение без requests
    requests = None

AUTH_URL = "https://auth.frontierstore.net/auth"
TOKEN_URL = "https://auth.frontierstore.net/token"
DECODE_URL = "https://auth.frontierstore.net/decode"
ME_URL = "https://auth.frontierstore.net/me"
CAPI_BASE = "https://companion.orerve.net"

#: Данные Legacy-галактики (Horizons 3.8) живут на отдельном хосте — Frontier
#: развёл их после Odyssey Update 14. Пилоту, который играет только в Legacy,
#: Live-хост данных не отдаст.
CAPI_LEGACY_BASE = "https://legacy-companion.orerve.net"

#: Client ID приложения «ED Ring Colony» в Frontier Developer Zone (CAPI).
#: Публичный PKCE-клиент без секрета — тот же, что использует сайт.
APP_CLIENT_ID = "0d6027a7-2561-4e1b-af2e-2fe71b296bdd"

#: Публичный client_id официального компаньон-приложения Elite Dangerous.
#: Запасной вариант для совместимости (им пользуются EDMC/EDDI).
PUBLIC_CLIENT_ID = "2360653316734633"

#: Платформы аккаунта для параметра `audience`. Документация Frontier
#: (hosting.zaonce.net/docs/oauth2/instructions.html) перечисляет
#: `xbox|psn|steam|frontier|all`; `epic` там не описан, но принимается и
#: используется EDMC.
KNOWN_AUDIENCES = ("frontier", "steam", "epic", "xbox", "psn")

#: Значение по умолчанию — ровно то, что шлёт EDMC. Frontier сам предложит
#: нужный способ входа, и токен получит та учётка, которая владеет игрой.
DEFAULT_AUDIENCE = "frontier,steam,epic"

#: Человеческие названия для UI (ключ → подпись).
AUDIENCE_LABELS = (
    ("auto", "Авто (Frontier / Steam / Epic)"),
    ("frontier", "Только Frontier Store"),
    ("steam", "Только Steam"),
    ("epic", "Только Epic Games"),
    ("xbox", "Xbox"),
    ("psn", "PlayStation"),
)

#: Access-токен живёт ~4 часа; обновляем заранее, чтобы запрос не попал в
#: середину истечения.
TOKEN_SAFETY_MARGIN_SECONDS = 120

#: Сколько ждём, пока пользователь дойдёт до браузера и нажмёт «Разрешить».
DEFAULT_AUTH_TIMEOUT = 180.0

#: Версия приложения для User-Agent. Проставляется из colonial_helper.VERSION
#: (см. `set_app_version`), чтобы модуль не импортировал UI.
_APP_VERSION = "1.0"


def set_app_version(version: str) -> None:
    """Запомнить версию приложения для User-Agent запросов к Frontier."""
    global _APP_VERSION
    cleaned = "".join(ch for ch in str(version or "") if ch.isdigit() or ch == ".")
    _APP_VERSION = cleaned.strip(".") or "1.0"


def capi_user_agent(version: str = "") -> str:
    """User-Agent в формате, который требует Frontier: `EDCD-<App>-<версия>`.

    Шаблон из EDCD/FDevIDs — `EDCD-[A-Za-z]+-[.0-9]+`. Буквы и дефисы в версии
    недопустимы, поэтому оставляем только цифры и точки.
    """
    raw = version or _APP_VERSION
    cleaned = "".join(ch for ch in str(raw) if ch.isdigit() or ch == ".").strip(".")
    return f"EDCD-ColonialHelper-{cleaned or '1.0'}"


def normalize_audience(value) -> str:
    """Нормализовать выбор платформы в параметр `audience`.

    Пустое значение, `auto` и `all` дают список EDMC (`frontier,steam,epic`):
    он работает и для магазина Frontier, и для Steam/Epic. Неизвестные значения
    отбрасываются, порядок и дубли — чистятся.
    """
    raw = str(value or "").strip().lower()
    if not raw or raw in ("auto", "all", "any"):
        return DEFAULT_AUDIENCE
    aliases = {
        "egs": "epic",
        "epicgames": "epic",
        "epic-games": "epic",
        "frontierstore": "frontier",
    }
    parts = [aliases.get(part.strip(), part.strip())
             for part in raw.replace(" ", ",").split(",")]
    kept = [part for part in parts if part in KNOWN_AUDIENCES]
    # dict.fromkeys — уникальные значения с сохранением порядка.
    return ",".join(dict.fromkeys(kept)) or DEFAULT_AUDIENCE


def _b64url(raw: bytes, pad: bool) -> str:
    """URL-safe base64. Frontier требует «=» у верификатора и запрещает у challenge."""
    encoded = base64.urlsafe_b64encode(raw).decode("ascii")
    if pad:
        return encoded
    return encoded.rstrip("=")


def create_code_verifier() -> str:
    """32 случайных байта → верификатор PKCE (с «=» на конце — так требует Frontier)."""
    return _b64url(secrets.token_bytes(32), pad=True)


def create_code_challenge(verifier: str) -> str:
    """SHA-256 от верификатора → challenge, ОБЯЗАТЕЛЬНО без «=»."""
    return _b64url(hashlib.sha256(verifier.encode("utf-8")).digest(), pad=False)


def build_auth_url(client_id: str, redirect_uri: str, code_challenge: str,
                   state: str, audience: str = "", scope: str = "auth capi") -> str:
    """Ссылка на авторизацию Frontier (PKCE).

    `audience` по умолчанию — `frontier,steam,epic`: иначе пилоту со Steam или
    Epic Frontier выдаст токен учётки магазина, которая игрой не владеет, и
    CAPI ответит `400 Please Visit the store to purchase Elite: Dangerous`.
    """
    params = urlencode({
        "audience": normalize_audience(audience),
        "scope": scope,
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })
    return f"{AUTH_URL}?{params}"


def _free_port() -> int:
    """Свободный порт на 127.0.0.1 для локального обработчика редиректа."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Одноразовый обработчик `http://127.0.0.1:<port>/?code=…&state=…`."""

    result: Dict[str, str] = {}

    def do_GET(self):  # noqa: N802 - имя метода задаёт http.server
        query = parse_qs(urlparse(self.path).query)
        type(self).result = {
            "code": (query.get("code") or [""])[0],
            "state": (query.get("state") or [""])[0],
            "error": (query.get("error") or [""])[0],
        }
        body = (
            "<html><head><meta charset='utf-8'><title>Colonial Helper</title></head>"
            "<body style='font-family:system-ui;background:#101314;color:#eee;"
            "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            "<div style='text-align:center'><h2>Код авторизации получен</h2>"
            "<p>Окно можно закрыть. Colonial Helper сейчас проверит связь "
            "с Companion API — результат появится в приложении.</p></div>"
            "</body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args, **kwargs):  # тишина в консоли
        return


class CompanionAuthError(Exception):
    """Ошибка авторизации или запроса к CAPI.

    Помимо текста несёт разобранную причину: HTTP-код, эндпоинт и `hint` —
    что пилоту делать. UI показывает `hint` отдельной строкой, иначе человек
    видит только «HTTP 400» и не понимает, что выбрал не ту платформу.
    """

    def __init__(self, message: str, status: int = 0, endpoint: str = "",
                 hint: str = "", detail: str = "", host: str = ""):
        super().__init__(message)
        self.status = int(status or 0)
        self.endpoint = str(endpoint or "")
        self.hint = str(hint or "")
        self.detail = str(detail or "")
        self.host = str(host or "")

    @property
    def needs_relink(self) -> bool:
        """Нужна ли повторная авторизация (а не «подождать и повторить»)."""
        return self.status in (400, 401, 403, 422)


#: Фразы Frontier в теле ответа 400, означающие «этот аккаунт не владеет игрой».
_NO_GAME_MARKERS = ("purchase", "not own", "no game", "store to purchase")

#: Подсказка про платформу — самая частая причина 400.
_WRONG_PLATFORM_HINT = (
    "Скорее всего, вход выполнен не той учётной записью. Если игра куплена в "
    "Steam или Epic, нажмите «Отключить», выберите свою платформу в списке и "
    "подключитесь заново — на странице Frontier нужно войти кнопкой Steam/Epic, "
    "а не почтой. Проверить связку можно на user.frontierstore.net → Linked "
    "Thirdparty Accounts."
)


def describe_capi_error(status: int, body: str = "", endpoint: str = "") -> Tuple[str, str]:
    """HTTP-код и тело ответа CAPI → (сообщение, подсказка).

    Отдельный разбор нужен потому, что «HTTP 400» у Frontier значит вовсе не
    «кривой запрос»: чаще всего это токен аккаунта, за которым не числится
    Elite Dangerous.
    """
    text = str(body or "").strip()
    lowered = text.lower()
    where = f" ({endpoint})" if endpoint else ""

    if status == 400:
        if any(marker in lowered for marker in _NO_GAME_MARKERS):
            return (
                "Frontier не видит купленную Elite Dangerous у этого аккаунта "
                f"(HTTP 400{where})",
                _WRONG_PLATFORM_HINT,
            )
        return (
            f"Companion API отклонил запрос: HTTP 400{where}",
            _WRONG_PLATFORM_HINT
            + " Если аккаунт привязан к Epic, у Frontier есть известный сбой: "
              "CAPI отвечает 400 несколько дней после привязки "
              "(issues.frontierstore.net/issue-detail/21258) — помогает вход в "
              "игру и повторная авторизация позже.",
        )
    if status in (401, 403):
        return (
            f"Frontier отклонил токен доступа (HTTP {status}{where})",
            "Подключите Frontier заново: доступ отозван или выдан не на те "
            "права (scope).",
        )
    if status == 422:
        return (
            f"Токен доступа истёк (HTTP 422{where})",
            "Обновление токена не удалось — подключите Frontier заново.",
        )
    if status == 404:
        return (
            f"Companion API не знает такого адреса (HTTP 404{where})",
            "Скорее всего, Frontier снова поменял API — обновите Colonial Helper.",
        )
    if status == 418:
        return (
            "Companion API на техобслуживании (HTTP 418)",
            "Это временно и не ломает привязку — повторите через несколько минут.",
        )
    if status == 429:
        return (
            "Frontier ограничил частоту запросов (HTTP 429)",
            "CAPI разрешает примерно один запрос в минуту — подождите минуту.",
        )
    if status == 204:
        return (
            f"Frontier не вернул данных{where}",
            "Так бывает, пока командир ни разу не заходил в игру после "
            "привязки. Зайдите в игру и повторите.",
        )
    if 500 <= status < 600:
        return (
            f"Companion API временно недоступен (HTTP {status}{where})",
            "Сервис Frontier сбоит — повторите позже, привязку рвать не нужно.",
        )
    return (f"Companion API ответил HTTP {status}{where}", "")


class CompanionAuth:
    """PKCE-авторизация и хранение токенов Frontier."""

    def __init__(self, token_path: str, client_id: str = "", audience: str = ""):
        self.token_path = token_path
        self.client_id = (client_id or os.environ.get("FRONTIER_CLIENT_ID") or APP_CLIENT_ID).strip()
        self.audience = normalize_audience(audience)
        self._lock = threading.Lock()

    # -- хранилище токенов ------------------------------------------------
    def load(self) -> dict:
        try:
            with open(self.token_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
                return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, tokens: dict) -> None:
        tokens = dict(tokens or {})
        tokens["saved_at"] = time.time()
        tmp = f"{self.token_path}.part"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(tokens, handle)
        os.replace(tmp, self.token_path)
        try:
            os.chmod(self.token_path, 0o600)
        except OSError:
            pass

    def update(self, **fields) -> dict:
        """Дописать поля в файл токенов, не потеряв сами токены."""
        with self._lock:
            tokens = self.load()
            tokens.update(fields)
            self.save(tokens)
            return tokens

    def clear(self) -> None:
        try:
            os.remove(self.token_path)
        except OSError:
            pass

    # -- состояние привязки ----------------------------------------------
    def mark_verified(self, cmdr: str = "", host: str = "") -> None:
        """Записать, что CAPI реально ответил (привязка не «фиктивная»)."""
        self.update(verified_at=time.time(), verified_cmdr=str(cmdr or ""),
                    verified_host=str(host or ""), last_error="", last_hint="")

    def mark_failed(self, error: str, hint: str = "") -> None:
        """Записать, почему проверка связи не прошла."""
        self.update(last_error=str(error or ""), last_hint=str(hint or ""),
                    last_error_at=time.time())

    def status(self) -> dict:
        """Состояние привязки для UI: есть ли токен и подтверждён ли он."""
        tokens = self.load()
        return {
            "linked": bool(tokens.get("access_token")),
            "verified": bool(tokens.get("verified_at")),
            "verified_at": float(tokens.get("verified_at") or 0),
            "cmdr": str(tokens.get("verified_cmdr") or ""),
            "authorized_at": float(tokens.get("obtained_at") or tokens.get("saved_at") or 0),
            "audience": str(tokens.get("audience") or self.audience),
            "error": str(tokens.get("last_error") or ""),
            "hint": str(tokens.get("last_hint") or ""),
        }

    # -- авторизация ------------------------------------------------------
    def authorize(self, open_browser: bool = True,
                  timeout: float = DEFAULT_AUTH_TIMEOUT,
                  on_url: Optional[Callable[[str], None]] = None) -> dict:
        """Провести пользователя через авторизацию и вернуть токены.

        Args:
            open_browser: открыть ли браузер автоматически.
            timeout: сколько ждать возвращения кода.
            on_url: колбэк с ссылкой (чтобы показать её в логе приложения).
        """
        if requests is None:
            raise CompanionAuthError("Нет библиотеки requests: pip install requests")

        verifier = create_code_verifier()
        state = _b64url(secrets.token_bytes(16), pad=False)
        port = _free_port()
        redirect_uri = f"http://127.0.0.1:{port}/"
        url = build_auth_url(self.client_id, redirect_uri, create_code_challenge(verifier),
                             state, audience=self.audience)

        handler = type("_Handler", (_CallbackHandler,), {"result": {}})
        server = http.server.HTTPServer(("127.0.0.1", port), handler)
        server.timeout = 1.0
        thread = threading.Thread(target=self._serve_until_code, args=(server, handler, state, timeout),
                                  daemon=True)
        thread.start()

        if on_url:
            on_url(url)
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass

        thread.join(timeout + 2)
        server.server_close()

        result = handler.result or {}
        if result.get("error"):
            raise CompanionAuthError(f"Frontier отклонил доступ: {result['error']}")
        code = result.get("code") or ""
        if not code:
            raise CompanionAuthError("Код авторизации не получен (таймаут или закрыт браузер)")
        if result.get("state") and result["state"] != state:
            raise CompanionAuthError("Несовпал state: возможен перехват редиректа")

        tokens = self.exchange_code(code, verifier, redirect_uri)
        # Платформу запоминаем вместе с токенами: по ней видно, какой учёткой
        # заходили, если CAPI потом ответит «игра не куплена».
        tokens["audience"] = self.audience
        with self._lock:
            self.save(tokens)
        return tokens

    @staticmethod
    def _serve_until_code(server: "http.server.HTTPServer", handler, state: str, timeout: float) -> None:
        """Крутить локальный сервер, пока не придёт код (или не выйдет время)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            server.handle_request()
            if handler.result.get("code") or handler.result.get("error"):
                return

    def exchange_code(self, code: str, verifier: str, redirect_uri: str) -> dict:
        """Обменять код на токены. `client_secret` НЕ отправляется — это PKCE."""
        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }
        return self._token_request(payload)

    def refresh(self, refresh_token: str) -> dict:
        """Обновить access-токен. Для PKCE-клиента секрет тоже не нужен."""
        return self._token_request({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
        })

    def _token_request(self, payload: dict) -> dict:
        if requests is None:
            raise CompanionAuthError("Нет библиотеки requests: pip install requests")
        try:
            resp = requests.post(
                TOKEN_URL,
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "Accept": "application/json",
                         "User-Agent": capi_user_agent()},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise CompanionAuthError(f"Сетевая ошибка авторизации: {exc}") from exc
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if resp.status_code != 200 or not data.get("access_token"):
            message = data.get("message") or data.get("error") or resp.text[:200]
            raise CompanionAuthError(
                f"Frontier не выдал токен (HTTP {resp.status_code}): {message}",
                status=resp.status_code, endpoint="/token",
            )
        data["obtained_at"] = time.time()
        return data

    # -- доступ к токенам -------------------------------------------------
    def access_token(self, force_refresh: bool = False) -> str:
        """Актуальный access-токен: при необходимости обновляет его сам."""
        tokens = self.load()
        access = str(tokens.get("access_token") or "")
        refresh_token = str(tokens.get("refresh_token") or "")
        if not access:
            return ""

        expires_in = tokens.get("expires_in") or 14400
        obtained_at = tokens.get("obtained_at") or tokens.get("saved_at") or 0
        expired = time.time() >= (obtained_at + float(expires_in) - TOKEN_SAFETY_MARGIN_SECONDS)
        if not expired and not force_refresh:
            return access
        if not refresh_token:
            return ""

        try:
            with self._lock:
                fresh = self.refresh(refresh_token)
                merged = {**tokens, **fresh}
                self.save(merged)
                return str(merged.get("access_token") or "")
        except CompanionAuthError:
            # Refresh-токен живёт не дольше 25 дней: дальше нужна повторная
            # авторизация, которую делает пользователь.
            return ""

    def is_linked(self) -> bool:
        return bool(self.load().get("access_token"))


class CompanionClient:
    """Запросы к Companion API с автоматическим обновлением токена."""

    def __init__(self, auth: CompanionAuth):
        self.auth = auth
        #: Хост, который реально ответил на последний запрос (Live или Legacy).
        self.last_host = CAPI_BASE

    def _request(self, base: str, endpoint: str, token: str):
        try:
            return requests.get(
                f"{base}{endpoint}",
                headers={"Authorization": f"Bearer {token}",
                         "Accept": "application/json",
                         "User-Agent": capi_user_agent()},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise CompanionAuthError(f"Сетевая ошибка CAPI: {exc}", endpoint=endpoint,
                                     host=base) from exc

    def _get(self, endpoint: str, base: str = "", allow_legacy: bool = True) -> dict:
        if requests is None:
            raise CompanionAuthError("Нет библиотеки requests: pip install requests")
        token = self.auth.access_token()
        if not token:
            raise CompanionAuthError(
                "Нет активной авторизации Frontier", endpoint=endpoint,
                hint="Нажмите «Подключить Frontier» — сохранённый токен истёк или не получен.",
            )

        base = base or CAPI_BASE
        for attempt in (1, 2):
            resp = self._request(base, endpoint, token)
            status = int(getattr(resp, "status_code", 0) or 0)

            # 401/403 — доступ отозван, 422 — истёк access-токен (Frontier
            # отвечает именно так). Один раз пробуем обновить токен.
            if status in (401, 403, 422) and attempt == 1:
                token = self.auth.access_token(force_refresh=True)
                if not token:
                    raise CompanionAuthError(
                        "Требуется повторная авторизация Frontier", status=status,
                        endpoint=endpoint, host=base,
                        hint="Refresh-токен больше не принимается: подключите Frontier заново.",
                    )
                continue

            if status == 200:
                self.last_host = base
                try:
                    return resp.json()
                except ValueError as exc:
                    raise CompanionAuthError(
                        f"CAPI {endpoint}: некорректный JSON", status=status,
                        endpoint=endpoint, host=base,
                        hint="Ответ Frontier не разобрать — вероятно, идёт обслуживание.",
                    ) from exc

            body = str(getattr(resp, "text", "") or "")[:300]

            # Legacy-галактика живёт на другом хосте. Если Live отвечает 400/404,
            # пробуем Legacy — для пилота, оставшегося в Horizons 3.8, это
            # единственный рабочий адрес.
            if status in (400, 404) and allow_legacy and base == CAPI_BASE:
                try:
                    return self._get(endpoint, base=CAPI_LEGACY_BASE, allow_legacy=False)
                except CompanionAuthError:
                    pass  # причину показываем по ответу Live-хоста

            message, hint = describe_capi_error(status, body, endpoint)
            raise CompanionAuthError(message, status=status, endpoint=endpoint,
                                     hint=hint, detail=body, host=base)

        raise CompanionAuthError("CAPI: не удалось получить данные", endpoint=endpoint)

    def get_profile(self) -> dict:
        return self._get("/profile")

    def get_market(self) -> dict:
        return self._get("/market")

    def get_fleetcarrier(self) -> Optional[dict]:
        try:
            return self._get("/fleetcarrier")
        except CompanionAuthError:
            # Авианосца может не быть вовсе — это не ошибка.
            return None

    def verify(self) -> dict:
        """Проверить, что привязка живая, и записать результат рядом с токенами.

        Возвращает `{"ok", "cmdr", "stats", "error", "hint", "status", "host"}`.
        Именно этим отличается «токен сохранён» от «связь работает»: раньше
        приложение показывало зелёный статус сразу после OAuth, хотя CAPI
        отвечал 400.
        """
        try:
            profile = self.get_profile()
        except CompanionAuthError as exc:
            self.auth.mark_failed(str(exc), exc.hint)
            return {"ok": False, "error": str(exc), "hint": exc.hint,
                    "status": exc.status, "host": exc.host, "stats": {}, "cmdr": ""}

        stats = profile_to_stats(profile)
        cmdr = str(stats.get("cmdr") or "")
        if not stats:
            error = "Frontier вернул пустой профиль"
            hint = ("Командир ещё не заходил в игру после привязки — зайдите в "
                    "игру и нажмите «Обновить досье».")
            self.auth.mark_failed(error, hint)
            return {"ok": False, "error": error, "hint": hint, "status": 200,
                    "host": self.last_host, "stats": {}, "cmdr": cmdr}

        self.auth.mark_verified(cmdr, self.last_host)
        return {"ok": True, "error": "", "hint": "", "status": 200,
                "host": self.last_host, "stats": stats, "cmdr": cmdr,
                "profile": profile}


def _int_or_none(value):
    """Число из ответа CAPI. `None` — когда поля нет вовсе.

    Различать «нет данных» и «ноль» принципиально: сервер обновляет досье
    частичным payload'ом, и подставленный по умолчанию ноль затёр бы
    настоящие значения командира (баланс, ранги, счётчики исследований).
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _first_present(*values):
    """Первое значение, которое реально присутствует в ответе (не None)."""
    for value in values:
        if value is not None:
            return value
    return None


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _name_of(value) -> str:
    """Имя из узла CAPI: он бывает и объектом `{name: …}`, и просто строкой."""
    if isinstance(value, dict):
        name = value.get("name")
        return str(name).strip() if isinstance(name, str) else ""
    if isinstance(value, str):
        return value.strip()
    return ""


def profile_to_stats(profile: dict) -> dict:
    """Ответ CAPI `/profile` → payload `POST /api/cmdr/stats`.

    Разбираются обе формы ответа:

    * настоящая структура CAPI — `commander.credits`, `commander.rank.*`,
      `lastSystem.name`, `lastStarport.name`, `ship.name` / `ship.shipName`;
    * «плоская» форма (`credits`, `rank`, `ship`, `last_system`), которую
      отдают кэши и фикстуры — раньше код умел только её, поэтому досье
      оставалось пустым даже при успешном ответе Frontier.

    Берём только то, что сайт хранит в `pilot_stats`/`capi_profiles`: баланс,
    ранги, текущее положение, счётчики исследований. Лишние поля (корабли,
    инженерия, груз) не отправляем — они там не нужны.

    В результат попадают только поля, которые Frontier реально вернул:
    отсутствующие ключи не подставляются нулями (см. `_int_or_none`).
    """
    profile = profile if isinstance(profile, dict) else {}
    commander = _dict(profile.get("commander"))
    # `rank` лежит внутри commander; верхний уровень — запасной путь.
    ranks = _dict(commander.get("rank")) or _dict(profile.get("rank")) or _dict(profile.get("ranks"))
    stats = _dict(profile.get("statistics"))
    bank = _dict(stats.get("bank_account"))
    exploration = _dict(stats.get("exploration"))
    exo = _dict(stats.get("exobiology"))
    combat = _dict(stats.get("combat"))

    result: Dict[str, object] = {
        "cmdr": commander.get("name") or None,
        "credits": _first_present(_int_or_none(commander.get("credits")),
                                  _int_or_none(profile.get("credits")),
                                  _int_or_none(bank.get("current_wealth"))),
        "arx": _int_or_none(profile.get("arx")),
        "mercenary_coins": _first_present(_int_or_none(profile.get("mercenary_payout")),
                                          _int_or_none(combat.get("combat_bond_profits"))),
        "mercenary_rank": _int_or_none(ranks.get("soldier")),
        "exobiologist_rank": _int_or_none(ranks.get("exobiologist")),
        "combat_rank": _int_or_none(ranks.get("combat")),
        "trade_rank": _int_or_none(ranks.get("trade")),
        "explore_rank": _int_or_none(ranks.get("explore")),
        "empire_rank": _int_or_none(ranks.get("empire")),
        "federation_rank": _int_or_none(ranks.get("federation")),
        "first_discoveries_count": _first_present(_int_or_none(exploration.get("systems_scanned")),
                                                  _int_or_none(exploration.get("planets_scanned_to_level_2"))),
        "first_mapped_count": _int_or_none(exploration.get("planets_scanned_to_level_3")),
        "first_footfalls_count": _int_or_none(exploration.get("first_footfalls")),
        "bio_samples_count": _int_or_none(exo.get("organic_data_count")),
        "bio_species_count": _int_or_none(exo.get("organic_species_encountered")),
        "bio_value_cr": _int_or_none(exo.get("organic_data_profits")),
    }

    exploration_stats = {
        key: value for key, value in {
            "efficiency": _int_or_none(exploration.get("efficiency_score")),
            "highest_payout": _int_or_none(exploration.get("highest_payout")),
            "systems_scanned": _int_or_none(exploration.get("systems_scanned")),
        }.items() if value is not None
    }
    if exploration_stats:
        result["exploration_stats"] = exploration_stats

    ship_node = profile.get("ship")
    if isinstance(ship_node, dict):
        ship_type = str(ship_node.get("name") or "").strip()
        ship_name = str(ship_node.get("shipName") or "").strip()
    else:
        ship_type = str(ship_node or "").strip()
        ship_name = str(profile.get("ship_name") or "").strip()
    if ship_type:
        result["current_ship"] = f"{ship_type} ({ship_name})" if ship_name else ship_type
    elif ship_name:
        result["current_ship"] = ship_name

    ship_dict = _dict(ship_node)
    last_system = (_name_of(profile.get("lastSystem"))
                   or _name_of(profile.get("last_system"))
                   or _name_of(ship_dict.get("starsystem")))
    if last_system:
        result["current_system"] = last_system

    last_station = (_name_of(profile.get("lastStarport"))
                    or _name_of(profile.get("last_station"))
                    or _name_of(ship_dict.get("station")))
    if last_station:
        result["current_station"] = last_station

    return {key: value for key, value in result.items() if value is not None}


def decode_token(access_token: str) -> dict:
    """Расшифровать access-токен на сервере Frontier (`/decode`).

    Полезно для проверки «чей это токен» без собственной регистрации клиента:
    Frontier сверяет срок и возвращает Frontier ID/e-mail владельца.
    """
    if requests is None:
        raise CompanionAuthError("Нет библиотеки requests: pip install requests")
    try:
        resp = requests.post(DECODE_URL, data={"token": access_token},
                             headers={"User-Agent": capi_user_agent()}, timeout=30)
        return resp.json() if resp.status_code == 200 else {}
    except (requests.RequestException, ValueError):
        return {}


def fetch_identity(access_token: str) -> dict:
    """Кто владелец токена (`/me`): платформа, e-mail, имя.

    Нужен для диагностики «фиктивной» привязки: если CAPI отвечает 400, а
    `/me` показывает `platform: frontier` у пилота со Steam — видно, что вход
    выполнен не той учёткой.
    """
    if requests is None:
        return {}
    try:
        resp = requests.get(ME_URL,
                            headers={"Authorization": f"Bearer {access_token}",
                                     "Accept": "application/json",
                                     "User-Agent": capi_user_agent()},
                            timeout=30)
        if int(getattr(resp, "status_code", 0) or 0) != 200:
            return {}
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except (requests.RequestException, ValueError):
        return {}
