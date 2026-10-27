"""Native Qt shell for the Colonial Helper main window.

This replaces the Tk-facade chrome (header, sidebar navigator, status bar) with
real PySide6 widgets. Pages are hosted in a ``QStackedWidget``; while a page is
still being migrated it may remain a compatibility widget, because the host
accepts any ``QWidget``.

Why the shell exists: the old navigator mixed a Tk-style layout API with Qt
widgets, so every new control could behave differently on Windows. The shell
keeps one native layout model, one place for navigation state and one place for
the status line.
"""
from __future__ import annotations

import sys
from typing import Callable, Dict, List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QPushButton,
    QSizePolicy,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from ui_navigation import SidebarNavigator
from ui_qt import (
    panel,
    CYAN,
    LINE,
    MUTED,
    ORANGE,
    PANEL_ALT,
    TEXT,
    WINDOW_STYLE,
    label,
)

SIDEBAR_WIDTH = 224


class PageHost(QWidget):
    """Container that pages are parented to.

    Kept compatible with the transitional widget API: a page may still call
    ``pack()`` on a child of the host while it is being migrated, so the host
    exposes the same layout lookup the old container did.
    """

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._tk_children: List[QWidget] = []
        self._host_layout = QVBoxLayout(self)
        self._host_layout.setContentsMargins(0, 0, 0, 0)
        self._host_layout.setSpacing(0)

    def _get_tk_layout(self, kind: str = "pack", side=None):
        return self._host_layout


class HelperShell(QWidget):
    """Header, sidebar navigation, page stack and status line."""

    def __init__(self, root: QWidget, *, on_change: Optional[Callable] = None,
                 version: str = "") -> None:
        super().__init__(root)
        self.root = root
        self.on_change = on_change
        self.version = str(version)
        self._pages: List[QWidget] = []
        self._titles: Dict[QWidget, str] = {}
        self._buttons: Dict[QWidget, QPushButton] = {}
        self._markers: Dict[QWidget, QFrame] = {}
        self._selected: Optional[QWidget] = None
        self.setStyleSheet(WINDOW_STYLE)
        self.setObjectName("shell")
        self._build()
        self._pack_into_root()
        self._take_over_window_style()

    # ------------------------------------------------------------------ build
    def _build(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 10, 14, 10)
        outer.setSpacing(10)
        outer.addWidget(self._header())

        body = QWidget()
        body_layout = QHBoxLayout(body)
        body_layout.setContentsMargins(0, 0, 0, 0)
        body_layout.setSpacing(12)
        body_layout.addWidget(self._sidebar(), 0)
        body_layout.addWidget(self._workspace(), 1)
        outer.addWidget(body, 1)
        outer.addWidget(self._status_bar())

    def _header(self) -> QWidget:
        frame = panel(QWidget(), "panelAlt")
        frame.setFixedHeight(74)
        frame.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(0, 0, 16, 0)
        layout.setSpacing(14)
        accent = QFrame()
        accent.setObjectName("accentOrange")
        accent.setFixedWidth(5)
        layout.addWidget(accent)

        titles = panel(QWidget(), "panelClear")
        titles_layout = QVBoxLayout(titles)
        titles_layout.setContentsMargins(0, 10, 0, 10)
        titles_layout.setSpacing(2)
        titles_layout.addWidget(label("◆  ED RING COLONY", size=15, bold=True, color=ORANGE))
        titles_layout.addWidget(label(
            "ПАНЕЛЬ УПРАВЛЕНИЯ  ·  F12 — показать или скрыть оверлей",
            role="muted", size=9))
        layout.addWidget(titles)
        layout.addStretch(1)
        self.version_label = label(f"v{self.version}" if self.version else "",
                                   role="mono", size=9, color=MUTED)
        layout.addWidget(self.version_label)
        return frame

    def _sidebar(self) -> QWidget:
        side = panel(QWidget(), "panel")
        side.setFixedWidth(SIDEBAR_WIDTH)
        layout = QVBoxLayout(side)
        layout.setContentsMargins(12, 16, 12, 12)
        layout.setSpacing(8)

        brand = panel(QWidget(), "panelClear")
        brand_layout = QHBoxLayout(brand)
        brand_layout.setContentsMargins(4, 0, 4, 0)
        brand_layout.setSpacing(10)
        marker = QFrame()
        marker.setObjectName("accentCyan")
        marker.setFixedWidth(3)
        marker.setMinimumHeight(28)
        brand_layout.addWidget(marker)
        brand_text = panel(QWidget(), "panelClear")
        brand_text_layout = QVBoxLayout(brand_text)
        brand_text_layout.setContentsMargins(0, 0, 0, 0)
        brand_text_layout.setSpacing(2)
        brand_text_layout.addWidget(label("ED RING COLONY", role="accent", size=9, bold=True))
        brand_text_layout.addWidget(label("SHIP SYSTEMS  /  DESKTOP",
                                          role="mono", size=7, color=MUTED))
        brand_layout.addWidget(brand_text)
        layout.addWidget(brand)
        layout.addSpacing(6)
        layout.addWidget(label("РАЗДЕЛЫ", role="muted", size=8, bold=True))

        self.nav_items = QWidget()
        self.nav_layout = QVBoxLayout(self.nav_items)
        self.nav_layout.setContentsMargins(0, 0, 0, 0)
        self.nav_layout.setSpacing(4)
        layout.addWidget(self.nav_items)
        layout.addStretch(1)

        self.sidebar_hint = label("Журналы анализируются\nлокально\nF12 — оверлей",
                                  role="muted", size=8, wrap=True)
        layout.addWidget(self.sidebar_hint)
        self.sidebar_hint.setMaximumWidth(SIDEBAR_WIDTH - 24)
        return side

    def _workspace(self) -> QWidget:
        frame = panel(QWidget(), "panel")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        heading = QWidget()
        heading_layout = QVBoxLayout(heading)
        heading_layout.setContentsMargins(18, 13, 18, 12)
        heading_layout.setSpacing(4)
        row = panel(QWidget(), "panelClear")
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        self.title_label = label("", size=14, bold=True)
        self.title_label.setObjectName("pageTitle")
        row_layout.addWidget(self.title_label)
        row_layout.addStretch(1)
        row_layout.addWidget(label("LIVE  /  COMMAND DECK", role="mono", size=8, color=CYAN))
        heading_layout.addWidget(row)
        heading_layout.addWidget(label("ED RING COLONY   /   ПАНЕЛЬ УПРАВЛЕНИЯ",
                                       role="mono", size=8, color=MUTED))
        layout.addWidget(heading)

        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        layout.addWidget(line)

        self.content_area = PageHost(frame)
        self.stack = QStackedWidget(self.content_area)
        self.stack.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.content_area._host_layout.addWidget(self.stack)
        layout.addWidget(self.content_area, 1)
        return frame

    def _status_bar(self) -> QWidget:
        frame = panel(QWidget(), "panelClear")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(5)
        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        layout.addWidget(line)
        self.bottom_status = label("Готов", role="mono", size=9, color=MUTED)
        self.bottom_status.setObjectName("statusLine")
        layout.addWidget(self.bottom_status)
        return frame

    def _pack_into_root(self) -> None:
        """Attach the shell to the window created by the bootstrapper."""
        layout = None
        getter = getattr(self.root, "_get_tk_layout", None)
        if callable(getter):
            layout = getter("pack")
        else:
            layout = self.root.layout()
        if layout is not None and hasattr(layout, "addWidget"):
            # The shell brings its own padding; keep the host from adding more.
            if hasattr(layout, "setContentsMargins"):
                try:
                    layout.setContentsMargins(0, 0, 0, 0)
                except Exception:
                    pass
            layout.addWidget(self)
        self.show()

    def _take_over_window_style(self) -> None:
        """Replace the window's blanket stylesheet with the scoped shell theme.

        The compatibility window sets a bare ``background/color`` rule, which in
        Qt applies to the window *and every descendant*: it painted dark blocks
        over the shell's panels. Scoped rules only affect the shell's own tree.
        """
        setter = getattr(self.root, "setStyleSheet", None)
        if callable(setter):
            try:
                setter(WINDOW_STYLE)
            except Exception:
                pass

    # -------------------------------------------------------------- public API
    def add(self, page: QWidget, text: str) -> None:
        """Register a page and give it a navigation button."""
        title = str(text).strip()
        self._pages.append(page)
        self._titles[page] = title
        self.stack.addWidget(page)

        row = panel(QWidget(), "panelClear")
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(6)
        marker = QFrame()
        marker.setObjectName("navMarker")
        marker.setFixedWidth(3)
        marker.setMinimumHeight(26)
        marker.setStyleSheet(f"background:{LINE};")
        row_layout.addWidget(marker)
        button = QPushButton(title)
        button.setProperty("variant", "nav")
        button.setCheckable(True)
        button.setCursor(Qt.CursorShape.PointingHandCursor)
        button.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; color: {MUTED};"
            f" text-align: left; padding: 7px 9px; border-radius: 6px; font-weight: 600; }}"
            f"QPushButton:hover {{ background: {LINE}; color: {TEXT}; }}"
            f"QPushButton:checked {{ background: {PANEL_ALT}; color: {ORANGE}; }}")
        button.clicked.connect(lambda _checked=False, page=page: self.select(page))
        row_layout.addWidget(button, 1)
        self.nav_layout.addWidget(row)
        self._buttons[page] = button
        self._markers[page] = marker

    def select(self, page=None):
        """Select a page, or return an identifier for the current one."""
        if page is None:
            return str(self._selected) if self._selected is not None else ""
        if isinstance(page, str):
            page = next((candidate for candidate in self._pages
                         if str(candidate) == page), None)
            if page is None:
                return ""
        if page not in self._titles:
            return ""
        if page is self._selected:
            return str(page)
        self._selected = page
        self.stack.setCurrentWidget(page)
        self.title_label.setText(self._titles[page])
        for candidate, button in self._buttons.items():
            selected = candidate is page
            button.setChecked(selected)
            self._markers[candidate].setStyleSheet(
                f"background:{ORANGE if selected else LINE};")
        if callable(self.on_change):
            self.on_change()
        return str(page)

    def set_status(self, text: str) -> None:
        self.bottom_status.setText(str(text))

    def status(self) -> str:
        return self.bottom_status.text()

    @property
    def pages(self) -> List[QWidget]:
        return list(self._pages)

    def title(self) -> str:
        return self.title_label.text()


class LegacyShell:
    """Fallback chrome used only when the Qt runtime is unavailable.

    Keeps the program usable (and the headless test suite running) with the
    previous sidebar navigator; the normal path is :class:`HelperShell`.
    """

    def __init__(self, root, *, on_change=None, version: str = "") -> None:
        import qt_lazy

        self.root = root
        self.version = str(version)
        self._navigator = SidebarNavigator(root, qt_lazy.tb, on_change=on_change)
        self.content_area = self._navigator.content_area
        self._pages = self._navigator._pages
        self._titles = self._navigator._titles
        self._status = None

    def add(self, page, text: str) -> None:
        self._navigator.add(page, text)

    def select(self, page=None):
        return self._navigator.select(page)

    def set_status(self, text: str) -> None:
        import qt_lazy

        if self._status is None:
            self._status = qt_lazy.tb.Label(self.root, text=str(text))
            try:
                self._status.pack(fill="x")
            except Exception:
                pass
        else:
            try:
                self._status.configure(text=str(text))
            except Exception:
                pass

    def status(self) -> str:
        getter = getattr(self._status, "cget", None)
        if callable(getter):
            try:
                return str(getter("text"))
            except Exception:
                return ""
        return ""


def build_shell(root, *, on_change=None, version: str = ""):
    """Native Qt shell, or the legacy fallback when Qt cannot start.

    A missing GUI runtime must not prevent the program from opening its
    windows, so the failure is reported and the previous chrome is used.
    """
    try:
        from ui_qt import ensure_app

        ensure_app()
        return HelperShell(root, on_change=on_change, version=version)
    except BaseException as exc:
        detail = str(exc).splitlines()[0] if str(exc) else ""
        print(f"Qt-оболочка недоступна ({type(exc).__name__}"
              f"{': ' + detail[:160] if detail else ''}); "
              "используется прежняя навигация", file=sys.stderr)
        return LegacyShell(root, on_change=on_change, version=version)
