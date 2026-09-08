"""HTTP клиент для ED Ring Colony API."""
import requests
import hashlib

API_BASE = "https://ed-ring-colony.vercel.app/api"


def _safe_json(resp: requests.Response) -> dict:
    """Безопасно распарсить JSON-ответ.

    Если сервер вернул не-JSON (HTML-страница ошибки 500/502/504,
    "413 Payload Too Large" от Vercel, обрыв serverless-функции по таймауту,
    пустое тело и т.п.) — resp.json() кидает json.JSONDecodeError, который
    раньше НИКЕМ не ловился (только requests.RequestException) и падал как
    необработанное исключение прямо в фоновом потоке загрузки, оставляя UI
    в подвешенном состоянии без понятной ошибки пользователю.
    """
    try:
        return resp.json()
    except ValueError:
        snippet = (resp.text or "")[:200].replace("\n", " ").strip()
        return {
            "ok": False,
            "error": f"Сервер вернул некорректный ответ (HTTP {resp.status_code}): {snippet or 'пустое тело'}",
        }


class ApiClient:
    def __init__(self, token: str = ""):
        self.token = token
        self.user_id = None
        self.cmdr_name = None
        self.email = None
        self.token_name = None
        self._session = requests.Session()

    def validate_token(self, token: str) -> dict:
        """Проверить API токен. Возвращает {ok, user_id, cmdr_name, email, token_name}."""
        try:
            resp = self._session.post(
                f"{API_BASE}/auth/token",
                json={"token": token},
                timeout=15,
            )
            data = _safe_json(resp)
            if resp.ok and data.get("ok"):
                self.token = token
                self.user_id = data.get("user_id")
                self.cmdr_name = data.get("cmdr_name")
                self.email = data.get("email")
                self.token_name = data.get("token_name")
                return {"ok": True, **data}
            return {"ok": False, "error": data.get("error", "Unknown error")}
        except requests.RequestException as e:
            return {"ok": False, "error": f"Сетевая ошибка: {e}"}

    def upload_deliveries(self, deliveries: list, cmdr: str = None) -> dict:
        """Загрузить список доставок. Возвращает {inserted, eventsFound, error, partial}."""
        if not self.token:
            return {"ok": False, "error": "Нет токена"}
        chunk_size = 500
        total_inserted = 0
        total_events = 0
        failed_chunks = 0
        last_error = ""
        for i in range(0, len(deliveries), chunk_size):
            chunk = deliveries[i : i + chunk_size]
            try:
                resp = self._session.post(
                    f"{API_BASE}/logs/upload",
                    json={"token": self.token, "cmdr": cmdr, "deliveries": chunk},
                    timeout=30,
                )
                data = _safe_json(resp)
                if not resp.ok:
                    failed_chunks += 1
                    last_error = data.get("error", f"Upload failed (HTTP {resp.status_code})")
                    continue
                total_inserted += data.get("inserted", 0)
                total_events += data.get("eventsFound", 0)
            except requests.RequestException as e:
                failed_chunks += 1
                last_error = f"Сетевая ошибка: {e}"
                continue
            except Exception as e:
                # Подстраховка: любая другая неожиданная ошибка на чанке не
                # должна ронять весь процесс загрузки (и оставлять UI
                # в подвешенном состоянии) — считаем чанк неудачным и идём дальше.
                failed_chunks += 1
                last_error = f"Неожиданная ошибка: {e}"
                continue
        if failed_chunks > 0:
            return {
                "ok": False,
                "error": f"Частичная ошибка ({failed_chunks} чанков не загружено): {last_error}",
                "inserted": total_inserted,
                "eventsFound": total_events,
                "partial": True,
            }
        return {"ok": True, "inserted": total_inserted, "eventsFound": total_events}

    @property
    def is_connected(self) -> bool:
        return bool(self.token and self.user_id)

    @property
    def display_name(self) -> str:
        return self.cmdr_name or self.email or "Пользователь"
