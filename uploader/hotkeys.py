#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Глобальные горячие клавиши для оверлея.

Привязки Tk работают только пока в фокусе окно приложения, а HUD нужен во
время игры, когда в фокусе Elite Dangerous. Поэтому клавиши регистрируются
средствами ОС (WinAPI `RegisterHotKey`) в отдельном потоке с собственным
циклом сообщений; срабатывание передаётся в главный поток Tk через
`master.after(0, ...)` — иначе виджеты трогать нельзя.

На не-Windows системах модуль остаётся рабочим «пустышкой»: `register()`
возвращает False, приложение просто не получает горячих клавиш, но не падает.
Никаких сторонних зависимостей — только ctypes.
"""

import sys
import threading
import time
from typing import Callable, Dict, List, Optional, Tuple

_IS_WINDOWS = sys.platform.startswith("win")

# Модификаторы WinAPI (MOD_*)
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
# Порядок в строке «Ctrl+Alt+F5» может быть любым.
MODIFIERS = {
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "alt": MOD_ALT,
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
    "super": MOD_WIN,
}

WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
PM_REMOVE = 0x0001
PM_NOREMOVE = 0x0000

# F1..F24, цифры, латиница и служебные клавиши.
VK_NAMES: Dict[str, int] = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D,
    "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "pageup": 0x21, "pagedown": 0x22, "end": 0x23, "home": 0x24,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "delete": 0x2E, "numlock": 0x90,
}
for _index in range(1, 25):
    VK_NAMES[f"f{_index}"] = 0x6F + _index
for _char in "0123456789":
    VK_NAMES[_char] = ord(_char)
for _char in "abcdefghijklmnopqrstuvwxyz":
    VK_NAMES[_char] = ord(_char.upper())
for _index, _name in enumerate([
    "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
]):
    VK_NAMES[_name] = 0xC0 + _index if _name == "`" else ord(_name.upper())


# Обратное отображение: виртуальный код -> подпись (F1..F12, A..Z, 0..9).
VK_LABELS: Dict[int, str] = {}
for _name, _code in VK_NAMES.items():
    if _code in VK_LABELS:
        continue
    if len(_name) == 1:
        VK_LABELS[_code] = _name.upper()
    elif _name.startswith("f") and _name[1:].isdigit():
        VK_LABELS[_code] = _name.upper()


def parse_hotkey(text: str) -> Optional[Tuple[int, int]]:
    """Разобрать «Ctrl+Alt+F5» в (модификаторы, виртуальный код клавиши).

    Возвращает None, если строка пустая или не распознана — вызывающий код
    treats это как «горячая клавиша не задана».
    """
    if not text:
        return None
    parts = [part.strip().lower() for part in str(text).replace("-", "+").split("+")]
    parts = [part for part in parts if part]
    if not parts:
        return None
    mods = 0
    key = None
    for part in parts:
        if part in MODIFIERS:
            mods |= MODIFIERS[part]
        elif key is None:
            key = part
        else:
            return None  # больше одной основной клавиши
    if key is None:
        return None
    if key.isdigit() and len(key) == 1:
        vk = ord(key)
    else:
        vk = VK_NAMES.get(key)
    if vk is None:
        return None
    return mods, vk


def normalize_hotkey(text: str) -> str:
    """Привести строку к каноническому виду («ctrl+alt+f5» → «Ctrl+Alt+F5»)."""
    parsed = parse_hotkey(text)
    if parsed is None:
        return ""
    mods, vk = parsed
    parts: List[str] = []
    if mods & MOD_CONTROL:
        parts.append("Ctrl")
    if mods & MOD_ALT:
        parts.append("Alt")
    if mods & MOD_SHIFT:
        parts.append("Shift")
    if mods & MOD_WIN:
        parts.append("Win")
    name = VK_LABELS.get(vk)
    parts.append(name if name else chr(vk))
    return "+".join(parts)


class HotkeyManager:
    """Регистрация глобальных горячих клавиш и доставка их в главный поток.

    `master` — корневое окно Tk: колбэки вызываются через `master.after(0, …)`,
    чтобы не трогать виджеты из чужого потока. Если мастера нет (тесты),
    колбэк вызывается прямо в потоке обработки сообщений.
    """

    def __init__(self, master=None, logger: Optional[Callable[[str], None]] = None):
        self.master = master
        self.logger = logger
        self.available = _IS_WINDOWS
        self.last_error: str = "" if _IS_WINDOWS else "Горячие клавиши доступны только в Windows"
        self._bindings: Dict[str, Callable] = {}
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._reload = threading.Event()
        self._started = False

    # -- публичное API ------------------------------------------------------
    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def register(self, combo: str, callback: Callable) -> bool:
        """Привязать комбинацию к колбэку. Пустая строка — снять привязку."""
        parsed = parse_hotkey(combo)
        if parsed is None:
            return False
        if callback is None:
            return False
        self._bindings[combo] = callback
        self._reload.set()
        return True

    def unregister(self, combo: str) -> None:
        if self._bindings.pop(combo, None) is not None:
            self._reload.set()

    def clear(self) -> None:
        if self._bindings:
            self._bindings.clear()
            self._reload.set()

    def combos(self) -> List[str]:
        return list(self._bindings.keys())

    def start(self) -> bool:
        """Запустить поток обработки. Повторный вызов просто обновляет набор."""
        if not _IS_WINDOWS:
            return False
        if self.running:
            self._reload.set()
            return True
        self._stop.clear()
        self._reload.set()
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="overlay-hotkeys")
        self._thread.start()
        self._started = True
        return True

    def stop(self) -> None:
        """Остановить поток и снять все регистрации."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread and thread.is_alive():
            thread.join(timeout=2.0)
        self._started = False

    # -- внутреннее ---------------------------------------------------------
    def _log(self, message: str) -> None:
        if self.logger:
            try:
                self.logger(message)
            except Exception:
                pass

    def _dispatch(self, callback: Callable) -> None:
        """Вызвать колбэк в главном потоке Tk."""
        if self.master is not None:
            try:
                self.master.after(0, callback)
                return
            except Exception:
                pass
        try:
            callback()
        except Exception:
            pass

    def _loop(self) -> None:
        """Цикл сообщений потока: регистрация + приём WM_HOTKEY."""
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.RegisterHotKey.restype = wintypes.BOOL
            user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int,
                                              wintypes.UINT, wintypes.UINT]
            user32.UnregisterHotKey.restype = wintypes.BOOL
            user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG),
                                            wintypes.HWND, wintypes.UINT,
                                            wintypes.UINT, wintypes.UINT]
        except Exception as exc:  # pragma: no cover — только если ctypes сломан
            self.available = False
            self.last_error = f"не удалось инициализировать WinAPI: {exc}"
            self._log(f"Горячие клавиши отключены: {exc}")
            return

        msg = wintypes.MSG()
        # Создаём очередь сообщений потока (иначе WM_HOTKEY некуда доставлять).
        user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_NOREMOVE)

        registered: Dict[int, str] = {}  # id -> combo
        next_id = 1

        def register_all() -> None:
            """Перерегистрировать весь набор (после изменения привязок)."""
            for hotkey_id in list(registered):
                try:
                    user32.UnregisterHotKey(None, hotkey_id)
                except Exception:
                    pass
            registered.clear()
            next_id = 1
            for combo in list(self._bindings):
                parsed = parse_hotkey(combo)
                if parsed is None:
                    continue
                mods, vk = parsed
                hotkey_id = next_id
                next_id += 1
                try:
                    if user32.RegisterHotKey(None, hotkey_id, mods, vk):
                        registered[hotkey_id] = combo
                    else:
                        self.last_error = f"клавиша {combo} занята другим приложением"
                        self._log(f"Не удалось назначить горячую клавишу {combo}: занята")
                except Exception as exc:
                    self.last_error = str(exc)
                    self._log(f"Ошибка регистрации {combo}: {exc}")

        register_all()
        self._reload.clear()

        while not self._stop.is_set():
            if self._reload.is_set():
                self._reload.clear()
                register_all()
            got = user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE)
            if got:
                if msg.message == WM_HOTKEY:
                    combo = registered.get(int(msg.wParam))
                    callback = self._bindings.get(combo or "")
                    if callback is not None:
                        self._dispatch(callback)
                elif msg.message == WM_QUIT:
                    break
            else:
                # Опрос, а не блокирующий GetMessage: поток должен уметь
                # завершиться сам, без внешнего PostThreadMessage.
                time.sleep(0.05)

        for hotkey_id in list(registered):
            try:
                user32.UnregisterHotKey(None, hotkey_id)
            except Exception:
                pass
        registered.clear()
