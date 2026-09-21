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
from typing import Callable, Dict, Optional
from urllib.parse import parse_qs, urlencode, urlparse

try:
    import requests
except ImportError:  # pragma: no cover - окружение без requests
    requests = None

AUTH_URL = "https://auth.frontierstore.net/auth"
TOKEN_URL = "https://auth.frontierstore.net/token"
DECODE_URL = "https://auth.frontierstore.net/decode"
CAPI_BASE = "https://companion.orerve.net"

#: Client ID приложения «ED Ring Colony» в Frontier Developer Zone (CAPI).
#: Публичный PKCE-клиент без секрета — тот же, что использует сайт.
APP_CLIENT_ID = "0d6027a7-2561-4e1b-af2e-2fe71b296bdd"

#: Публичный client_id официального компаньон-приложения Elite Dangerous.
#: Запасной вариант для совместимости (им пользуются EDMC/EDDI).
PUBLIC_CLIENT_ID = "2360653316734633"

#: Access-токен живёт ~4 часа; обновляем заранее, чтобы запрос не попал в
#: середину истечения.
TOKEN_SAFETY_MARGIN_SECONDS = 120

#: Сколько ждём, пока пользователь дойдёт до браузера и нажмёт «Разрешить».
DEFAULT_AUTH_TIMEOUT = 180.0


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
                   state: str, audience: str = "frontier", scope: str = "auth capi") -> str:
    """Ссылка на авторизацию Frontier (PKCE)."""
    params = urlencode({
        "audience": audience,
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
            "<div style='text-align:center'><h2>Авторизация завершена</h2>"
            "<p>Окно можно закрыть и вернуться в Colonial Helper.</p></div>"
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
    """Ошибка авторизации или запроса к CAPI."""


class CompanionAuth:
    """PKCE-авторизация и хранение токенов Frontier."""

    def __init__(self, token_path: str, client_id: str = "", audience: str = "frontier"):
        self.token_path = token_path
        self.client_id = (client_id or os.environ.get("FRONTIER_CLIENT_ID") or APP_CLIENT_ID).strip()
        self.audience = audience
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

    def clear(self) -> None:
        try:
            os.remove(self.token_path)
        except OSError:
            pass

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
                         "Accept": "application/json"},
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
            raise CompanionAuthError(f"Frontier не выдал токен (HTTP {resp.status_code}): {message}")
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

    def _get(self, endpoint: str) -> dict:
        if requests is None:
            raise CompanionAuthError("Нет библиотеки requests: pip install requests")
        token = self.auth.access_token()
        if not token:
            raise CompanionAuthError("Нет активной авторизации Frontier")

        for attempt in (1, 2):
            try:
                resp = requests.get(
                    f"{CAPI_BASE}{endpoint}",
                    headers={"Authorization": f"Bearer {token}",
                             "Accept": "application/json"},
                    timeout=30,
                )
            except requests.RequestException as exc:
                raise CompanionAuthError(f"Сетевая ошибка CAPI: {exc}") from exc

            # 401/403 — доступ отозван, 422 — истёк access-токен (Frontier
            # отвечает именно так). Один раз пробуем обновить токен.
            if resp.status_code in (401, 403, 422) and attempt == 1:
                token = self.auth.access_token(force_refresh=True)
                if not token:
                    raise CompanionAuthError("Требуется повторная авторизация Frontier")
                continue
            if resp.status_code != 200:
                raise CompanionAuthError(f"CAPI {endpoint}: HTTP {resp.status_code}")
            try:
                return resp.json()
            except ValueError as exc:
                raise CompanionAuthError(f"CAPI {endpoint}: некорректный JSON") from exc
        raise CompanionAuthError("CAPI: не удалось получить данные")

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


def profile_to_stats(profile: dict) -> dict:
    """Ответ CAPI `/profile` → payload `POST /api/cmdr/stats`.

    Берём только то, что сайт хранит в `pilot_stats`/`capi_profiles`: баланс,
    ранги, текущее положение, счётчики исследований. Лишние поля (корабли,
    инженерия, груз) не отправляем — они там не нужны.

    В результат попадают только поля, которые Frontier реально вернул:
    отсутствующие ключи не подставляются нулями (см. `_int_or_none`).
    """
    profile = profile if isinstance(profile, dict) else {}
    commander = profile.get("commander") or {}
    ranks = profile.get("rank") or {}
    stats = profile.get("statistics") or {}
    bank = stats.get("bank_account") or {}
    exploration = stats.get("exploration") or {}
    exo = stats.get("exobiology") or {}
    combat = stats.get("combat") or {}

    result: Dict[str, object] = {
        "cmdr": commander.get("name") or None,
        "credits": _first_present(_int_or_none(profile.get("credits")),
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

    ship = profile.get("ship") or ""
    name = profile.get("ship_name") or ""
    if ship:
        result["current_ship"] = f"{ship} ({name})" if name else ship
    last_system = (profile.get("last_system") or {}).get("name")
    if last_system:
        result["current_system"] = last_system
    last_station = (profile.get("last_station") or {}).get("name")
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
        resp = requests.post(DECODE_URL, data={"token": access_token}, timeout=30)
        return resp.json() if resp.status_code == 200 else {}
    except (requests.RequestException, ValueError):
        return {}
