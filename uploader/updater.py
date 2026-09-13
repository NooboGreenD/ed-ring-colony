"""Обновления Colonial Helper: проверка версии и загрузка сборки из Releases.

Сборки публикует CI (`.github/workflows/build-exe.yml`) **со всех веток** —
`main` и `arena/**`:

===========  ===========================================================
Ветка        Релиз
===========  ===========================================================
`main`       полноценный релиз, тег `v{версия}`, `prerelease = false`
`arena/**`   тестовая сборка, тег `v{версия}-{ветка}`, `prerelease = true`
===========  ===========================================================

Программа при запуске (и по кнопке «Обновить») спрашивает GitHub API,
сравнивает версию и предлагает скачать новую сборку. Канал обновлений
выбирается в интерфейсе:

* `stable` — только полноценные релизы (сборки `main`);
* `all`    — включая prerelease из рабочих веток `arena/**`.

Модуль намеренно не зависит от tkinter: его можно импортировать из CI
(`python uploader/updater.py --notes`) и тестировать без GUI.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

#: Репозиторий, в релизах которого лежат сборки.
GITHUB_OWNER = "NooboGreenD"
GITHUB_REPO = "ed-ring-colony"
GITHUB_API = "https://api.github.com"
RELEASES_URL = f"{GITHUB_API}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"

#: Сколько релизов смотрим за один запрос (без пагинации).
RELEASES_PER_PAGE = 30
#: Сколько байт читаем за раз при скачивании.
DOWNLOAD_CHUNK = 1024 * 256
#: Таймауты запросов (подключение, чтение).
TIMEOUT = (10, 30)
#: Сколько строк ченджлога попадает в описание релиза.
NOTES_MAX_LINES = 60

#: Имя файла, который ищем в релизе, в порядке предпочтения.
ASSET_PREFERENCES = (".exe", ".zip", ".msi")

_VERSION_RE = re.compile(r'^VERSION\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


# ---------------------------------------------------------------------------
#  Версии
# ---------------------------------------------------------------------------
def version_tuple(text) -> Tuple[int, ...]:
    """«2.4.10» -> (2, 4, 10).

    Всё нечисловое отбрасывается, поэтому `v2.4.2-arena-01a09bd7`
    сравнивается как (2, 4, 2) — суффикс ветки не должен делать сборку
    «новее» стабильной.
    """
    raw = str(text or "").strip().lstrip("vV")
    # Только ведущая «числовая» часть: у `v2.4.2-arena-01a09bd7` цифры есть
    # и в суффиксе ветки, и брать их в версию нельзя — иначе сборка arena
    # оказалась бы «новее» стабильной той же версии.
    match = re.match(r"(\d+(?:\.\d+)*)", raw)
    if not match:
        return ()
    numbers: List[int] = []
    for part in match.group(1).split("."):
        try:
            numbers.append(int(part))
        except ValueError:
            break
    return tuple(numbers)


def compare_versions(left, right) -> int:
    """-1 / 0 / 1 — как обычное сравнение, но по числовым частям."""
    a, b = version_tuple(left), version_tuple(right)
    if a == b:
        return 0
    return -1 if a < b else 1


def current_version(source: Optional[Path] = None) -> str:
    """Версия программы из `colonial_helper.VERSION`.

    Читаем литерал регуляркой, а не импортом: модуль тянет за собой tkinter,
    а этот файл нужен и в CI, и в тестах без GUI.
    """
    path = source or Path(__file__).resolve().parent / "colonial_helper.py"
    try:
        match = _VERSION_RE.search(path.read_text(encoding="utf-8"))
    except OSError:
        return ""
    return match.group(1) if match else ""


# ---------------------------------------------------------------------------
#  Разбор релизов GitHub
# ---------------------------------------------------------------------------
def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def pick_asset(assets: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Выбрать файл сборки из списка ассетов релиза.

    Сначала по расширению из `ASSET_PREFERENCES`, внутри расширения — самый
    крупный файл (на случай, если в релизе и exe, и исходники).
    """
    items = [a for a in (assets or []) if isinstance(a, dict)]
    for suffix in ASSET_PREFERENCES:
        candidates = [
            a for a in items
            if str(a.get("name", "")).lower().endswith(suffix)
        ]
        if candidates:
            return max(candidates, key=lambda a: _as_int(a.get("size")))
    return None


def parse_release(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Релиз GitHub -> компактный словарь, который удобно сравнивать.

    Возвращает None, если в релизе нет версии или файла сборки: пустой тег
    или релиз «только текст» обновлением считаться не должны.
    """
    if not isinstance(item, dict):
        return None
    tag = str(item.get("tag_name") or "").strip()
    if not tag or not version_tuple(tag):
        return None
    asset = pick_asset(item.get("assets") or [])
    if asset is None:
        return None
    return {
        "tag": tag,
        "version": version_tuple(tag),
        "version_text": tag.lstrip("vV"),
        "name": str(item.get("name") or tag),
        "body": str(item.get("body") or ""),
        "prerelease": bool(item.get("prerelease")),
        "draft": bool(item.get("draft")),
        "url": str(item.get("html_url") or ""),
        "published_at": str(item.get("published_at") or ""),
        "asset_name": str(asset.get("name") or ""),
        "asset_size": _as_int(asset.get("size")),
        "asset_url": str(asset.get("browser_download_url") or ""),
    }


def _sort_key(release: Dict[str, Any]):
    """Сортировка кандидатов: версия, затем дата публикации."""
    return (release["version"], release.get("published_at") or "")


def choose_release(releases: Iterable[Dict[str, Any]], channel: str = "stable",
                   current: str = "") -> Optional[Dict[str, Any]]:
    """Лучший релиз под канал обновлений.

    `stable` — пропускаем prerelease и черновики (это сборки `main`).
    `all`    — берём и prerelease из веток `arena/**`.
    Черновики не предлагаем никогда: они ещё не опубликованы.
    """
    candidates = [r for r in releases if r and not r.get("draft")]
    if channel != "all":
        candidates = [r for r in candidates if not r.get("prerelease")]
    if current:
        base = version_tuple(current)
        candidates = [r for r in candidates if r["version"] > base]
    if not candidates:
        return None
    return max(candidates, key=_sort_key)


def check_for_update(current: str, channel: str = "stable",
                     session=None) -> Dict[str, Any]:
    """Есть ли сборка новее `current`.

    Возвращает `{"ok", "update_available", "current", "latest", "release",
    "error"}`. Исключений не бросает: вызов идёт из фонового потока, а
    отсутствие сети не должно ломать запуск программы.
    """
    result: Dict[str, Any] = {
        "ok": False,
        "update_available": False,
        "current": str(current or ""),
        "latest": "",
        "release": None,
        "error": None,
    }
    try:
        import requests
    except ImportError as exc:  # pragma: no cover - requests в requirements
        result["error"] = f"Нет библиотеки requests: {exc}"
        return result

    http = session
    if http is None:
        try:
            http = requests.Session()
        except Exception as exc:
            result["error"] = str(exc)
            return result

    headers = {
        "Accept": "application/vnd.github+json",
        # GitHub просит называть клиент: без User-Agent часть запросов
        # отклоняется, а по нему видно, откуда нагрузка.
        "User-Agent": f"ColonialHelper/{current or 'dev'} (update check)",
    }
    try:
        response = http.get(
            RELEASES_URL,
            params={"per_page": RELEASES_PER_PAGE},
            headers=headers,
            timeout=TIMEOUT,
        )
    except Exception as exc:
        result["error"] = f"GitHub недоступен: {exc}"
        return result

    if not getattr(response, "ok", False):
        result["error"] = f"GitHub ответил HTTP {getattr(response, 'status_code', '?')}"
        return result
    try:
        payload = response.json()
    except ValueError:
        result["error"] = "GitHub вернул некорректный ответ"
        return result
    if not isinstance(payload, list):
        result["error"] = "Неожиданный формат списка релизов"
        return result

    releases = [r for r in (parse_release(item) for item in payload) if r]
    result["ok"] = True
    best = choose_release(releases, channel=channel, current=current)
    if best is None:
        newest = max(releases, key=_sort_key) if releases else None
        result["latest"] = newest["version_text"] if newest else str(current or "")
        return result
    result["update_available"] = True
    result["latest"] = best["version_text"]
    result["release"] = best
    return result


def download_asset(release: Dict[str, Any], dest_dir, progress=None,
                   session=None) -> Dict[str, Any]:
    """Скачать файл сборки из релиза в `dest_dir`.

    `progress(done_bytes, total_bytes)` вызывается по мере скачивания —
    интерфейс показывает проценты. Пишем во временный файл и переименовываем:
    оборванный Download не должен оставлять «почти готовый» exe.
    """
    result: Dict[str, Any] = {"ok": False, "path": "", "size": 0, "error": None}
    url = str((release or {}).get("asset_url") or "")
    name = str((release or {}).get("asset_name") or "ColonialHelper.exe")
    if not url:
        result["error"] = "В релизе нет ссылки на файл сборки"
        return result
    try:
        import requests
    except ImportError as exc:  # pragma: no cover
        result["error"] = f"Нет библиотеки requests: {exc}"
        return result

    path = Path(dest_dir)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        result["error"] = f"Не удалось создать папку {path}: {exc}"
        return result

    http = session
    if http is None:
        try:
            http = requests.Session()
        except Exception as exc:
            result["error"] = str(exc)
            return result

    target = path / name
    tmp = target.with_suffix(target.suffix + ".part")
    total = 0
    done = 0
    try:
        with http.get(url, stream=True, timeout=TIMEOUT,
                      headers={"User-Agent": "ColonialHelper/update"}) as response:
            if not getattr(response, "ok", False):
                result["error"] = f"HTTP {getattr(response, 'status_code', '?')} при скачивании"
                return result
            total = _as_int(response.headers.get("Content-Length"))
            with open(tmp, "wb") as handle:
                for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    done += len(chunk)
                    if progress:
                        try:
                            progress(done, total)
                        except Exception:
                            pass
        tmp.replace(target)
    except Exception as exc:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        result["error"] = f"Скачивание прервано: {exc}"
        return result

    result["ok"] = True
    result["path"] = str(target)
    result["size"] = done or total
    return result


def download_folder() -> Path:
    """Куда складывать скачанные сборки: «Загрузки» или временная папка."""
    import tempfile

    for candidate in (Path.home() / "Downloads", Path.home() / "Загрузки"):
        try:
            if candidate.is_dir():
                return candidate
        except OSError:
            continue
    return Path(tempfile.gettempdir())


# ---------------------------------------------------------------------------
#  Ченджлог для релиза (его же вызывает CI)
# ---------------------------------------------------------------------------
_ROUND_RE = re.compile(r"^# Раунд ", re.MULTILINE)


def latest_changelog(changes_path=None, max_lines: int = NOTES_MAX_LINES) -> str:
    """Свежий раздел `uploader/CHANGES.md` — «небольшой ченджлог» для релиза.

    Берём текст от последнего заголовка `# Раунд …` до следующего такого же
    (или до конца файла) и обрезаем по строкам: в описание релиза не нужно
    вываливать всю историю.
    """
    path = Path(changes_path) if changes_path else Path(__file__).resolve().parent / "CHANGES.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    starts = [m.start() for m in _ROUND_RE.finditer(text)]
    if not starts:
        return text.strip()[:4000]
    begin = starts[0]
    end = starts[1] if len(starts) > 1 else len(text)
    section = text[begin:end].strip()
    lines = section.splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines] + ["…", "", "Полная история — `uploader/CHANGES.md`."]
    return "\n".join(lines).strip()


def build_release_notes(version: str, branch: str = "", commit: str = "",
                        changes_path=None) -> str:
    """Текст описания релиза: версия, ветка, коммит и свежий ченджлог."""
    head = [f"**Colonial Helper {version}**", ""]
    if branch:
        head.append(f"* Ветка: `{branch}`")
    if commit:
        head.append(f"* Коммит: `{commit[:12]}`")
    head.append("* Сборка: Windows x64, `ColonialHelper.exe` (артефакт прикрепён ниже)")
    head.append("")
    notes = latest_changelog(changes_path)
    return "\n".join(head + ([notes] if notes else ["Изменений не описано."]))


def _cli(argv: List[str]) -> int:
    """Мини-CLI для CI: `--version`, `--notes`, `--tag`."""
    import argparse

    parser = argparse.ArgumentParser(description="Служебный CLI обновлений")
    parser.add_argument("--version", action="store_true", help="версия из colonial_helper.py")
    parser.add_argument("--notes", action="store_true", help="описание релиза")
    parser.add_argument("--tag", action="store_true", help="тег релиза для ветки")
    parser.add_argument("--branch", default="", help="имя ветки (для --tag/--notes)")
    parser.add_argument("--commit", default="", help="SHA коммита (для --notes)")
    args = parser.parse_args(argv)

    version = current_version()
    if args.version:
        print(version)
        return 0
    if args.notes:
        print(build_release_notes(version, args.branch, args.commit))
        return 0
    if args.tag:
        print(release_tag(version, args.branch))
        return 0
    parser.print_help()
    return 1


def release_tag(version: str, branch: str) -> str:
    """Тег релиза: `v2.4.2` для main и `v2.4.2-arena-имя` для рабочих веток.

    У разных веток одна и та же версия, поэтому без суффикса ветки они
    перезаписывали бы релиз друг друга.
    """
    branch = (branch or "").strip()
    if not branch or branch == "main":
        return f"v{version}"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", branch).strip("-").lower()[:40]
    return f"v{version}-{slug}" if slug else f"v{version}"


if __name__ == "__main__":  # pragma: no cover - CLI для CI
    import sys

    raise SystemExit(_cli(sys.argv[1:]))
