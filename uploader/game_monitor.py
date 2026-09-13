"""Отслеживание запуска Elite Dangerous.

Зачем отдельный модуль
----------------------

Раньше в `overlay.py` была только проверка «в фокусе ли окно игры»
(`_is_ed_foreground()`), да и та возвращала `True` в любом неоднозначном
случае («чтобы оверлей не пропал»). Из-за этого приложение не могло ответить
на простой вопрос пользователя — **запущена ли игра вообще** — и не могло
спрятать HUD, когда игры нет.

Здесь живёт `GameMonitor`: определяет процесс игры, её окно, прямоугольник
окна и монитор, на котором оно находится. Монитор нужен для раскладки
оверлеев: на втором экране с нестандартным разрешением привязка «к углу
экрана» по `winfo_screenwidth()` уводила бы окна за пределы видимости.

Зависимости: только стандартная библиотека. На Windows используется ctypes
(Win32 API), на остальных платформах монитор возвращает
`state.error = "unsupported platform"` — приложение при этом просто показывает
«игра не запущена» и не падает.
"""

import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

IS_WINDOWS = sys.platform == "win32"

# Процессы клиента игры (старые/новые/legacy-сборки).
GAME_PROCESS_NAMES = (
    "EliteDangerous64.exe",
    "EliteDangerous32.exe",
    "EliteDangerous.exe",
)

# Подстроки заголовков окон игры.
GAME_WINDOW_TITLES = (
    "Elite - Dangerous",
    "Elite Dangerous",
)


@dataclass
class GameState:
    """Состояние игры на момент последней проверки."""

    running: bool = False
    focused: bool = False
    pid: int = 0
    process_name: str = ""
    hwnd: Optional[int] = None
    title: str = ""
    # Прямоугольник окна игры: (left, top, right, bottom)
    rect: Optional[Tuple[int, int, int, int]] = None
    # Рабочая область монитора, на котором находится окно
    monitor: Optional[Tuple[int, int, int, int]] = None
    checked_at: float = 0.0
    error: str = ""

    @property
    def width(self) -> int:
        return (self.rect[2] - self.rect[0]) if self.rect else 0

    @property
    def height(self) -> int:
        return (self.rect[3] - self.rect[1]) if self.rect else 0

    def as_dict(self) -> Dict:
        return {
            "running": self.running,
            "focused": self.focused,
            "pid": self.pid,
            "process_name": self.process_name,
            "title": self.title,
            "rect": self.rect,
            "monitor": self.monitor,
            "error": self.error,
        }

    def label(self) -> str:
        """Короткий текст для UI."""
        if self.error:
            return f"недоступно ({self.error})"
        if not self.running:
            return "не запущена"
        return "в фокусе" if self.focused else "запущена"


# ============================================================
#  Win32 helpers
# ============================================================
def _win32_processes() -> List[Tuple[int, str]]:
    """Список (pid, имя процесса) через CreateToolhelp32Snapshot.

    Возвращает пустой список на не-Windows или при любой ошибке — монитор
    должен быть устойчивым, а не падать посреди игры.
    """
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32

        TH32CS_SNAPPROCESS = 0x00000002
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot == INVALID_HANDLE_VALUE:
            return []

        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)

        result: List[Tuple[int, str]] = []
        try:
            ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                result.append((int(entry.th32ProcessID), str(entry.szExeFile)))
                ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snapshot)
        return result
    except Exception:
        return []


def _win32_find_game_window() -> Tuple[Optional[int], str]:
    """Найти HWND и заголовок окна игры. Возвращает (None, "") если не найдено."""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        found: List[Tuple[int, str]] = []

        def foreach_window(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value
            if any(token.lower() in title.lower() for token in GAME_WINDOW_TITLES):
                found.append((hwnd, title))
                return False
            return True

        user32.EnumWindows(EnumWindowsProc(foreach_window), 0)
        if found:
            return found[0]
    except Exception:
        pass
    return None, ""


def _win32_window_rect(hwnd: int) -> Optional[Tuple[int, int, int, int]]:
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        rect = wintypes.RECT()
        if user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
            return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception:
        pass
    return None


def _win32_monitor_rect(hwnd: int) -> Optional[Tuple[int, int, int, int]]:
    """Рабочая область монитора, на котором находится окно (без таскбара)."""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        MONITOR_DEFAULTTONEAREST = 0x00000002
        monitor = user32.MonitorFromWindow(wintypes.HWND(hwnd), MONITOR_DEFAULTTONEAREST)

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            r = info.rcWork
            return int(r.left), int(r.top), int(r.right), int(r.bottom)
    except Exception:
        pass
    return None


def _win32_foreground_hwnd() -> Optional[int]:
    try:
        import ctypes

        return ctypes.windll.user32.GetForegroundWindow()
    except Exception:
        return None


# ============================================================
#  Монитор
# ============================================================
class GameMonitor:
    """Определяет, запущена ли игра, и где находится её окно.

    Опрос дешёвый (снимок процессов + поиск окна), но чтобы не делать его
    несколько раз за тик, результат кэшируется на `cache_ttl` секунд.

    `process_lister` можно подменить (тесты, нестандартные платформы) —
    это любая функция, возвращающая список `(pid, имя_процесса)`.
    """

    def __init__(
        self,
        cache_ttl: float = 1.0,
        process_lister: Optional[Callable[[], List[Tuple[int, str]]]] = None,
    ):
        self.cache_ttl = float(cache_ttl)
        self._injected_lister = process_lister is not None
        self._process_lister = process_lister or _win32_processes
        self._lock = threading.Lock()
        self._state = GameState()

    @property
    def state(self) -> GameState:
        """Актуальное состояние (обновляется не чаще раза в `cache_ttl`)."""
        now = time.monotonic()
        with self._lock:
            if (now - self._state.checked_at) < self.cache_ttl:
                return self._state
            state = self._probe(now)
            self._state = state
            return state

    def refresh(self) -> GameState:
        """Принудительно переопросить состояние."""
        with self._lock:
            self._state = self._probe(time.monotonic())
            return self._state

    # -- внутреннее --------------------------------------------------------
    def _probe(self, now: float) -> GameState:
        state = GameState(checked_at=now)
        if not IS_WINDOWS and not self._injected_lister:
            # Вне Windows определение процесса недоступно: честно говорим об
            # этом в UI вместо «игра не запущена», чтобы не вводить в заблуждение.
            state.error = "unsupported platform"
            return state
        try:
            processes = self._process_lister() or []
        except Exception as exc:
            processes = []
            state.error = f"process list unavailable: {exc}"

        for pid, name in processes:
            if name.lower() in {n.lower() for n in GAME_PROCESS_NAMES}:
                state.running = True
                state.pid = int(pid)
                state.process_name = name
                break

        if not state.running:
            return state

        hwnd, title = _win32_find_game_window()
        state.hwnd = hwnd
        state.title = title
        if hwnd:
            state.rect = _win32_window_rect(hwnd)
            state.monitor = _win32_monitor_rect(hwnd)
            foreground = _win32_foreground_hwnd()
            if foreground:
                state.focused = int(foreground) == int(hwnd)
        return state

    # -- удобные обёртки ---------------------------------------------------
    def is_running(self) -> bool:
        return self.state.running

    def is_focused(self) -> bool:
        return self.state.focused

    def label(self) -> str:
        return self.state.label()
