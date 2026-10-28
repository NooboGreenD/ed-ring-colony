"""Win32-часть HUD: HWND, «клик насквозь», самое верхнее окно.

Отдельный модуль, потому что этим пользуются и окна HUD (`hud_window`), и
`overlay.py`: раньше импорт шёл в обратную сторону и тянул за собой весь
менеджер оверлея.
"""
from __future__ import annotations

from typing import Optional

from game_monitor import _is_own_window, _win32_find_game_window, _win32_window_pid


def _get_ed_hwnd() -> Optional[int]:
    """Найти HWND окна Elite Dangerous.

    Здесь был свой `EnumWindows` + `GetWindowTextW` по всем видимым окнам —
    включая главное окно Colonial Helper и окна оверлея. `GetWindowTextW`
    для окна собственного процесса отправляет сообщение его потоку (главному
    потоку Tk) и ждёт ответа; этот вызов идёт из фонового потока
    `_update_loop` раз в секунду. Как только поток Tk оказывался занят (а он
    раз в секунду берёт `GameMonitor._lock`), оба потока вставали навсегда —
    приложение намертво зависало сразу после включения оверлея.

    Теперь поиск один и он в `game_monitor`: свои окна пропускаются по PID
    до чтения заголовка.
    """
    try:
        hwnd, _title = _win32_find_game_window()
        return hwnd
    except Exception:
        return None


def _is_ed_foreground() -> bool:
    """Проверить, активно ли сейчас окно Elite Dangerous."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        fg = user32.GetForegroundWindow()
        if not fg:
            # GetForegroundWindow вернул 0 — возможно, игра запущена от админа,
            # а uploader — нет. Считаем ED активной, чтобы оверлей не пропал.
            return True
        ed = _get_ed_hwnd()
        if ed and fg == ed:
            return True
        # Своё окно в фокусе — это не игра. Заголовок при этом не читаем:
        # GetWindowTextW для окна собственного процесса ждёт ответ главного
        # потока Tk (тот самый дедлок, что и в _get_ed_hwnd).
        try:
            import os

            if _is_own_window(_win32_window_pid(user32, fg), os.getpid()):
                return False
        except Exception:
            pass
        # Fallback: проверяем по заголовку foreground окна
        length = user32.GetWindowTextLengthW(fg)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(fg, buf, length + 1)
            title = buf.value
            return "Elite" in title and "Dangerous" in title
    except Exception:
        pass
    return True  # Fallback: считаем активной, чтобы оверлей не пропал


def _set_window_topmost(hwnd: int, topmost: bool):
    """Legacy Win32 hook retained for callers that still pass an HWND.

    Production topmost handling uses the PySide6 window flags via
    ``attributes('-topmost', ...)``; direct SetWindowPos is intentionally unused.
    """
    pass


#: Флаги Win32 для режима «клик насквозь».
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
LWA_ALPHA = 0x00000002
SWP_FRAMECHANGED = 0x0020
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
GA_ROOT = 2

#: user32 с прототипами функций; None — ещё не загружали, False — нет Win32.
_USER32 = None


def _user32():
    """user32 с прототипами (argtypes/restype) — или None вне Windows.

    Отдельный экземпляр `WinDLL`, а не общий `ctypes.windll.user32`:
    прототипы задаём только себе и не меняем поведение чужих модулей. Без
    них ctypes считает каждый результат 32-битным `int`, а HWND и стили на
    64-битной Windows — это указатели (`LONG_PTR`): значения обрезались, и
    `SetWindowLongPtrW` молча писала стиль не туда или не писала вовсе.
    """
    global _USER32
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return None
    if _USER32 is None:
        try:
            lib = ctypes.WinDLL("user32", use_last_error=True)
            hwnd_t = wintypes.HWND
            long_ptr = ctypes.c_ssize_t

            def proto(name, restype, *argtypes):
                func = getattr(lib, name)
                func.argtypes = list(argtypes)
                func.restype = restype
                return func

            try:
                get_style = proto("GetWindowLongPtrW", long_ptr, hwnd_t, ctypes.c_int)
                set_style = proto("SetWindowLongPtrW", long_ptr, hwnd_t, ctypes.c_int, long_ptr)
            except AttributeError:
                # 32-битная Windows: функций *Ptr* в user32 нет, стиль — LONG.
                get_style = proto("GetWindowLongW", wintypes.LONG, hwnd_t, ctypes.c_int)
                set_style = proto("SetWindowLongW", wintypes.LONG, hwnd_t, ctypes.c_int, wintypes.LONG)

            class _Api:
                GetAncestor = proto("GetAncestor", hwnd_t, hwnd_t, wintypes.UINT)
                IsWindow = proto("IsWindow", wintypes.BOOL, hwnd_t)
                GetWindowLong = get_style
                SetWindowLong = set_style
                SetLayeredWindowAttributes = proto(
                    "SetLayeredWindowAttributes", wintypes.BOOL,
                    hwnd_t, wintypes.DWORD, ctypes.c_ubyte, wintypes.DWORD,
                )
                SetWindowPos = proto(
                    "SetWindowPos", wintypes.BOOL, hwnd_t, hwnd_t,
                    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT,
                )
                GetForegroundWindow = proto("GetForegroundWindow", hwnd_t)
                GetWindowThreadProcessId = proto(
                    "GetWindowThreadProcessId", wintypes.DWORD,
                    hwnd_t, ctypes.POINTER(wintypes.DWORD),
                )

            _USER32 = _Api
        except Exception:
            _USER32 = False
    return _USER32 or None


def _toplevel_hwnd(window) -> Optional[int]:
    """HWND настоящего окна верхнего уровня — или None, пока его нет.

    Для Qt-окна (`QWidget`) рамка верхнего уровня и есть его собственный HWND,
    поэтому `winId()` и есть ответ. Прежний путь через `winfo_id()` и
    `GetAncestor(GA_ROOT)` остался для окон совместимого слоя.

    Tk на Windows рисует содержимое Toplevel в дочернем окне, а рамку
    («wrapper») создаёт только при первом показе — и пересоздаёт её при
    некоторых операциях (overrideredirect, -toolwindow, полноэкранный режим).
    Поэтому HWND нельзя запоминать навсегда, а до первого показа его просто
    нет: GetAncestor(GA_ROOT) вернёт само дочернее окно. Раньше «клик
    насквозь» применялся именно в этот момент — к несуществующему окну, — и
    не работал, пока его не перещёлкнешь вручную.
    """
    user32 = _user32()
    if user32 is None:
        return None
    try:
        if hasattr(window, "winId"):
            handle = int(window.winId())
            return handle if handle and user32.IsWindow(handle) else None
        child = int(window.winfo_id())
    except Exception:
        return None
    if not child:
        return None
    try:
        root = user32.GetAncestor(child, GA_ROOT)
        if not root or int(root) == child or not user32.IsWindow(root):
            return None
        return int(root)
    except Exception:
        return None


#: Старое имя: так помощник назывался, когда брал GetParent(winfo_id()).
_hwnd_of = _toplevel_hwnd


def _foreground_window() -> Optional[int]:
    """HWND активного окна (без чтения заголовка — см. _is_ed_foreground)."""
    user32 = _user32()
    if user32 is None:
        return None
    try:
        return int(user32.GetForegroundWindow() or 0) or None
    except Exception:
        return None


def _window_pid(hwnd: Optional[int]) -> int:
    """PID процесса, которому принадлежит окно (0 — не удалось узнать)."""
    user32 = _user32()
    if user32 is None or not hwnd:
        return 0
    try:
        import ctypes
        from ctypes import wintypes

        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return int(pid.value)
    except Exception:
        return 0


def _set_click_through(hwnd: int, enabled: bool, alpha: float = 1.0,
                       keep_layered: Optional[bool] = None) -> bool:
    """Сделать окно прозрачным для мыши (WS_EX_TRANSPARENT | WS_EX_LAYERED).

    Нужен именно Win32: обычные Qt surface attributes не умеют «клик насквозь». Окно остаётся
    видимым и поверх игры, но все щелчки уходят в игру. Возвращает True,
    только если нужный стиль действительно стоит на окне — это проверяется
    повторным чтением, поэтому неудачная запись больше не выдаёт себя за
    успех.

    Тонкости:

    * стиль пишем только когда он отличается от нужного: каждая запись
      пересобирает окно, и при постоянной перезаписи блок мерцал;
    * после смены расширенного стиля Windows требует
      ``SetWindowPos(..., SWP_FRAMECHANGED)``;
    * впервые включив ``WS_EX_LAYERED``, сразу задаём альфу через
      ``SetLayeredWindowAttributes``: слоистое окно без атрибутов Windows
      считает полностью прозрачным, и блок пропадал;
    * при выключении ``WS_EX_LAYERED`` снимаем, только если слой не нужен
      самому Tk (``keep_layered``): Tk ставит его для прозрачности < 100 %
      и считает, что он стоит навсегда, — сняв его, мы сломали бы
      дальнейшие смены прозрачности. По умолчанию слой оставляем при
      alpha < 1.0.
    """
    if not hwnd:
        return False
    user32 = _user32()
    if user32 is None:
        return False
    try:
        try:
            transparency = max(0.0, min(1.0, float(alpha)))
        except (TypeError, ValueError):
            transparency = 1.0
        if not user32.IsWindow(hwnd):
            return False
        style = int(user32.GetWindowLong(hwnd, GWL_EXSTYLE))
        if enabled:
            desired = style | WS_EX_TRANSPARENT | WS_EX_LAYERED
        else:
            desired = style & ~WS_EX_TRANSPARENT
            if keep_layered is None:
                keep_layered = transparency < 1.0
            if not keep_layered:
                desired &= ~WS_EX_LAYERED
        if desired != style:
            user32.SetWindowLong(hwnd, GWL_EXSTYLE, desired)
            if desired & WS_EX_LAYERED and not style & WS_EX_LAYERED:
                # Слоистое окно обязано иметь атрибуты, иначе оно не рисуется.
                user32.SetLayeredWindowAttributes(
                    hwnd, 0, int(round(transparency * 255)), LWA_ALPHA
                )
            user32.SetWindowPos(
                hwnd, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
            style = int(user32.GetWindowLong(hwnd, GWL_EXSTYLE))
        through = bool(style & WS_EX_TRANSPARENT)
        if enabled:
            return through and bool(style & WS_EX_LAYERED)
        return not through
    except Exception:
        return False

