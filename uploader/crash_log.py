"""Журнал падений Helper: без него «программа закрылась без ошибки» не разобрать.

Оконная сборка (`--windowed`) не имеет консоли: трассировка исключения из
фонового потока, из слота Qt или из нативной библиотеки уходит в никуда, и
пилот видит только исчезнувшее окно. Здесь три источника падений пишутся в
один файл `logs/helper.log` рядом с установкой:

* `sys.excepthook` — исключение в главном потоке;
* `threading.excepthook` — исключение в рабочем потоке (обновление, выгрузка,
  синхронизация журналов идут именно там и падали молча);
* `sys.unraisablehook` — исключение, проглоченное интерпретатором или Qt;
* `faulthandler` — нативные падения (access violation в драйвере, стек
  переполнен): остаётся стек всех потоков на момент падения.

Модуль ничего не решает и не перезапускает: он только оставляет след. Поэтому
любая ошибка записи журнала глушится — журнал не должен мешать программе
работать.
"""
from __future__ import annotations

import faulthandler
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

#: Имя файла рядом с `logs/launcher.log` — так оба журнала лежат в одном месте.
LOG_NAME = "helper.log"
#: Разделитель блоков: по нему видно, где кончается один запуск и падение.
MARK = "=" * 72
#: Сколько часов назад случившееся падение ещё считается «прошлым запуском».
RECENT_HOURS = 24
#: Сколько знаков причины показывать в окне (остальное — в журнале).
REASON_CHARS = 240

#: Русские строки файла: это диагностика для разбора падений, а не подписи
#: окна. Журнал читают поддержка и сам пилот по просьбе поддержки; перевод
#: сделал бы трассировки нечитаемыми для поиска по issues. Окно же (что
#: показать пилоту) собирается из `tr()`-ключей в `colonial_helper.py`.
NON_UI_LITERALS = frozenset({
    "исключение: ", "исключение:", "поток «", "проглоченное исключение",
    "запуск Helper ",
})

_state: Dict[str, Any] = {"installed": False, "path": None, "stream": None,
                          "hooks": None}


def default_root() -> Optional[Path]:
    """Каталог установки, куда писать журнал.

    Порядок: переменная лаунчера → `bundle.install_root()` → домашний каталог.
    Пустой результат означает «писать некуда», и это не ошибка.
    """
    override = os.environ.get("COLONIAL_HELPER_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    try:
        import bundle

        return Path(bundle.install_root())
    except Exception:
        pass
    try:
        return Path.home() / ".colonial_helper"
    except Exception:
        return None


def log_path(root=None) -> Path:
    folder = Path(root) if root else (default_root() or Path("."))
    return folder / "logs" / LOG_NAME


def _append(path: Path, text: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(str(text).rstrip() + "\n")
    except OSError:
        pass


def note(root, message: str) -> None:
    """Строка в журнал: запуск, версия, важные события."""
    if not message:
        return
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    _append(log_path(root), f"{stamp} {message}")


def _format(title: str, details: str) -> str:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    return f"\n{MARK}\n{stamp} {title}\n{MARK}\n{str(details).rstrip()}\n"


def install(root=None, *, version: str = "", extra: str = "") -> Optional[Path]:
    """Включить запись падений. Идемпотентно: повторный вызов ничего не меняет."""
    path = log_path(root)
    if _state["installed"] and _state["path"] == str(path):
        return path
    if _state["installed"]:
        # Другой каталог (установку перенесли): прежний файл и перехватчики
        # снимаем, иначе писали бы в два места сразу.
        uninstall()
    _state["installed"] = True
    _state["path"] = str(path)

    # Нативные падения: файл держим открытым, иначе faulthandler некуда писать.
    # Двоичный режим — потому что faulthandler пишет байты, а не текст: в
    # текстовом потоке кириллица из стека ломала бы запись.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = open(path, "ab", buffering=0)
        _state["stream"] = stream
        faulthandler.enable(stream, all_threads=True)
    except Exception:
        _state["stream"] = None

    prev_excepthook = sys.excepthook
    prev_threadhook = getattr(threading, "excepthook", None)
    prev_unraisablehook = getattr(sys, "unraisablehook", None)

    def excepthook(exc_type, exc, tb):
        if not issubclass(exc_type, KeyboardInterrupt):
            details = "".join(traceback.format_exception(exc_type, exc, tb))
            _append(path, _format(f"исключение: {exc_type.__name__}: {exc}", details))
        try:
            prev_excepthook(exc_type, exc, tb)
        except Exception:
            pass

    def threadhook(args):
        name = getattr(getattr(args, "thread", None), "name", "?")
        exc_type, exc, tb = args.exc_type, args.exc_value, args.exc_traceback
        details = "".join(traceback.format_exception(exc_type, exc, tb))
        _append(path, _format(f"поток «{name}»: {exc_type.__name__}: {exc}", details))
        if callable(prev_threadhook) and prev_threadhook is not threadhook:
            try:
                prev_threadhook(args)
            except Exception:
                pass

    def unraisablehook(args):
        details = f"{args.object!r}\n{args.exc_type.__name__}: {args.exc_value}\n{args.err_msg or ''}"
        _append(path, _format("проглоченное исключение", details))
        if callable(prev_unraisablehook) and prev_unraisablehook is not unraisablehook:
            try:
                prev_unraisablehook(args)
            except Exception:
                pass

    sys.excepthook = excepthook
    if prev_threadhook is not None:
        threading.excepthook = threadhook
    if prev_unraisablehook is not None:
        sys.unraisablehook = unraisablehook
    _state["hooks"] = (prev_excepthook, prev_threadhook, prev_unraisablehook,
                       excepthook, threadhook, unraisablehook)

    banner = f"запуск Helper {version}".strip()
    if extra:
        banner = f"{banner} ({extra})"
    note(root, banner)
    return path


def uninstall() -> None:
    """Вернуть прежние перехватчики (нужно тестам; в работе не зовётся)."""
    hooks = _state.get("hooks")
    if hooks:
        prev_excepthook, prev_threadhook, prev_unraisablehook, excepthook, threadhook, unraisablehook = hooks
        if sys.excepthook is excepthook:
            sys.excepthook = prev_excepthook
        if prev_threadhook is not None and threading.excepthook is threadhook:
            threading.excepthook = prev_threadhook
        if prev_unraisablehook is not None and getattr(sys, "unraisablehook", None) is unraisablehook:
            sys.unraisablehook = prev_unraisablehook
    stream = _state.get("stream")
    if stream is not None:
        try:
            faulthandler.disable()
            stream.close()
        except Exception:
            pass
    _state.update({"installed": False, "path": None, "stream": None, "hooks": None})


def recent_crash(root=None, hours: float = RECENT_HOURS) -> str:
    """Текст последнего падения, если оно случилось недавно.

    Нужно, чтобы следующий запуск мог честно сказать: «прошлый раз программа
    закрылась с ошибкой», а не делать вид, что всё хорошо. Пустая строка —
    падений не было (или журнала нет).
    """
    path = log_path(root)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    # Метки может и не быть: нативное падение оставляет только стек.
    blocks = [block for block in text.split(MARK + "\n") if block.strip()] if MARK in text else []
    limit = max(0.0, float(hours)) * 3600
    for block in reversed(blocks):
        head = block.strip().splitlines()[0] if block.strip() else ""
        if not any(marker in head for marker in ("исключение:", "поток «",
                                                 "проглоченное исключение")):
            continue
        stamp = head[:19]
        try:
            when = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
        if (time.time() - when) > limit:
            return ""
        return head.strip()
    # Нативное падение (`faulthandler`) пишет без метки времени: время берём у
    # самого файла — процесс, который его создал, уже не расскажет.
    tail = text[-4000:]
    index = tail.rfind("Fatal Python error")
    if index >= 0:
        try:
            when = path.stat().st_mtime
        except OSError:
            return ""
        if (time.time() - when) <= limit:
            line = tail[index:].splitlines()[0].strip()
            stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(when))
            return f"{stamp} {line}"
    return ""


def notice_details(root=None, hours: float = RECENT_HOURS):
    """`(причина, путь)` последнего падения — для строки в стартовом экране.

    Оба значения пустые, если журнала нет или падений не было: экран тогда
    показывает обычный текст, а не выдуманную причину.
    """
    reason = recent_crash(root, hours=hours) or ""
    # Время в строке интерфейсу не нужно: оно уже есть в самом журнале.
    if len(reason) > 20 and reason[4] == "-" and reason[7] == "-":
        reason = reason[20:].strip()
    # Исключение с длинным сообщением не должно занимать весь стартовый экран.
    if len(reason) > REASON_CHARS:
        reason = reason[:REASON_CHARS].rstrip() + "…"
    return reason, str(log_path(root))


def log_hint(root=None) -> str:
    """Путь журнала для сообщений интерфейса."""
    return str(log_path(root))
