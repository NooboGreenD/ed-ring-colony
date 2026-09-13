"""HTTP клиент для ED Ring Colony API."""
import requests
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor

API_BASE = "https://ed-ring-colony.vercel.app/api"

# Сколько доставок уходит в одном запросе и сколько запросов идёт параллельно.
#
# Раньше доставки отправлялись пачками по 25 СТРОГО последовательно: при
# первичной загрузке всей истории это давало больше тысячи последовательных
# запросов (каждый — отдельный round trip до Vercel), и только на сайт уходили
# десятки минут. Сервер принимает до 500 доставок в одном запросе, поэтому
# пачку увеличиваем, а запросы распараллеливаем — сами доставки при этом
# остаются идемпотентными (source_hash), так что порядок не важен.
DELIVERY_CHUNK_SIZE = 100
# Лимит сервера на snapshots ColonisationConstructionDepot в одном запросе.
CONSTRUCTION_CHUNK_SIZE = 100
UPLOAD_WORKERS = 4
MAX_UPLOAD_ATTEMPTS = 3

# Сессия requests НЕ потокобезопасна, поэтому у каждого потока своя.
# thread-local автоматически освобождается вместе с потоком пула.
_thread_state = threading.local()


def _session_for_thread() -> requests.Session:
    session = getattr(_thread_state, "session", None)
    if session is None:
        session = requests.Session()
        _thread_state.session = session
    return session


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

    def _post_upload(self, payload: dict, timeout: int = 30):
        """Один POST на /api/logs/upload из текущего потока."""
        resp = _session_for_thread().post(
            f"{API_BASE}/logs/upload",
            json=payload,
            timeout=timeout,
        )
        return resp, _safe_json(resp)

    def upload_deliveries(
        self,
        deliveries: list,
        cmdr: str = None,
        chunk_size: int = DELIVERY_CHUNK_SIZE,
        max_workers: int = UPLOAD_WORKERS,
        progress_cb=None,
    ) -> dict:
        """Загрузить список доставок. Возвращает {inserted, eventsFound, error, partial}.

        Пачки уходят параллельно (до `max_workers` запросов одновременно) —
        при первичной загрузке истории это сокращает время отправки на сайт
        в разы по сравнению с последовательной отправкой.

        Повторяем попытку только на "временных" сбоях: 429 (rate limit) и 5xx
        (сервер/таймаут serverless-функции). 4xx (400/401/403) — это ошибка
        валидации/авторизации, повтор не поможет и только тратит время впустую
        при большом импорте.
        """
        if not self.token:
            return {"ok": False, "error": "Нет токена"}
        if not deliveries:
            return {"ok": True, "inserted": 0, "eventsFound": 0}

        chunk_size = max(1, min(int(chunk_size), 500))  # 500 — лимит сервера
        chunks = [deliveries[i : i + chunk_size] for i in range(0, len(deliveries), chunk_size)]
        return self._upload_chunks(chunks, "deliveries", cmdr, max_workers, progress_cb)

    def upload_construction_events(
        self,
        events: list,
        cmdr: str = None,
        chunk_size: int = CONSTRUCTION_CHUNK_SIZE,
        max_workers: int = UPLOAD_WORKERS,
        progress_cb=None,
    ) -> dict:
        """Загрузить snapshots ColonisationConstructionDepot.

        Это отдельный поток данных от deliveries: snapshots описывают общий
        прогресс стройки и не должны увеличивать личный тоннаж командира.
        """
        if not self.token:
            return {"ok": False, "error": "Нет токена"}
        if not events:
            return {"ok": True, "inserted": 0}
        # Сервер отклоняет больше 100 snapshots в одном запросе (413).
        chunk_size = max(1, min(int(chunk_size), 100))
        chunks = [events[i : i + chunk_size] for i in range(0, len(events), chunk_size)]
        return self._upload_chunks(chunks, "construction_events", cmdr, max_workers, progress_cb)

    def _upload_chunks(self, chunks: list, field: str, cmdr: str, max_workers: int, progress_cb) -> dict:
        """Параллельно отправить пачки на /api/logs/upload и собрать результат."""
        total_chunks = len(chunks)
        lock = threading.Lock()
        state = {"inserted": 0, "events": 0, "snapshots": 0, "failed": 0, "done": 0, "last_error": ""}

        def notify_progress():
            if not progress_cb:
                return
            try:
                progress_cb(state["done"], total_chunks)
            except Exception:
                pass

        def worker(item):
            _index, chunk = item
            error = ""
            for attempt in range(1, MAX_UPLOAD_ATTEMPTS + 1):
                try:
                    resp, data = self._post_upload({"token": self.token, "cmdr": cmdr, field: chunk})
                    status = resp.status_code
                    if status == 429 or status >= 500:
                        error = data.get("error", f"Upload failed (HTTP {status})")
                        if attempt < MAX_UPLOAD_ATTEMPTS:
                            time.sleep(0.5 * attempt)
                            continue
                        break
                    if not resp.ok:
                        error = data.get("error", f"Upload failed (HTTP {status})")
                        break
                    with lock:
                        if field == "deliveries":
                            state["inserted"] += int(data.get("inserted", 0) or 0)
                            state["events"] += int(data.get("eventsFound", 0) or 0)
                        else:
                            state["inserted"] += int(data.get("constructionInserted", 0) or 0)
                            state["snapshots"] += int(data.get("snapshotInserted", 0) or 0)
                        state["done"] += 1
                    notify_progress()
                    return
                except requests.RequestException as e:
                    error = f"Сетевая ошибка: {e}"
                    if attempt < MAX_UPLOAD_ATTEMPTS:
                        time.sleep(0.5 * attempt)
                        continue
                    break
                except Exception as e:
                    # Подстраховка: любая другая неожиданная ошибка на чанке не
                    # должна ронять весь процесс загрузки (и оставлять UI
                    # в подвешенном состоянии) — считаем чанк неудачным.
                    error = f"Неожиданная ошибка: {e}"
                    break
            with lock:
                state["failed"] += 1
                state["done"] += 1
                state["last_error"] = error
            notify_progress()

        workers = max(1, min(int(max_workers or 1), total_chunks))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(worker, list(enumerate(chunks))))

        if state["failed"] > 0:
            result = {
                "ok": False,
                "error": f"Частичная ошибка ({state['failed']} чанков не загружено): {state['last_error']}",
                "inserted": state["inserted"],
                "partial": True,
            }
        else:
            result = {"ok": True, "inserted": state["inserted"]}
        if field == "deliveries":
            result["eventsFound"] = state["events"]
        else:
            result["constructionInserted"] = state["inserted"]
            result["snapshotInserted"] = state["snapshots"]
        result["chunks"] = total_chunks
        result["chunks_failed"] = state["failed"]
        return result

    @property
    def is_connected(self) -> bool:
        return bool(self.token and self.user_id)

    @property
    def display_name(self) -> str:
        return self.cmdr_name or self.email or "Пользователь"
