"""Public website configuration; the desktop never needs a Supabase key."""
from urllib.parse import urlsplit

DEFAULT_SITE_URL = "https://edringcolony.ru"
LEGACY_HOST = "ed-ring-colony.vercel.app"


def normalize_site_url(value: str = "") -> str:
    raw = str(value or DEFAULT_SITE_URL).strip()
    if any(char.isspace() for char in raw) or "\\" in raw:
        raise ValueError("Укажите полный HTTPS-адрес сайта без пробелов")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Некорректный адрес сервера") from exc
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path.rstrip("/") not in ("", "/api")):
        raise ValueError("Нужен адрес сайта, без логина, параметров и пути (кроме /api)")
    # Upgrade saved defaults without relying on an HTTP redirect carrying a token.
    if parsed.scheme in ("http", "https") and parsed.hostname in (
            LEGACY_HOST, "edringcolony.ru", "www.edringcolony.ru") and port in (None, 80, 443):
        return DEFAULT_SITE_URL
    if parsed.hostname == "supabase.edringcolony.ru":
        raise ValueError("Введите адрес сайта edringcolony.ru, а не сервера Supabase")
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("API-токены можно передавать только по HTTPS (HTTP допустим лишь для localhost)")
    hostname = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    default_port = 443 if parsed.scheme == "https" else 80
    suffix = f":{port}" if port and port != default_port else ""
    return f"{parsed.scheme}://{hostname}{suffix}"


def saved_connection(config: dict, credentials: dict) -> tuple[str, str]:
    """Restore a token only for the server it belonged to.

    A pre-migration credentials file had no site_url: it belongs to the
    official site, never to an arbitrary newly configured installation.
    """
    site = normalize_site_url(config.get("site_url", credentials.get("site_url", "")))
    credential_site = normalize_site_url(credentials.get("site_url", ""))
    token_site = normalize_site_url(config.get("token_site_url", ""))
    token = str(config.get("token", "") or "") if token_site == site else ""
    if credentials.get("token") and credential_site == site:
        token = str(credentials["token"])
    return site, token
