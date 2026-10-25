"""Launcher-inspired sidebar navigation for the Colonial Helper desktop UI."""
from __future__ import annotations


class SidebarNavigator:
    """A small page switcher that keeps the old Notebook.select() contract.

    Pages remain ordinary Tk frames, so existing feature widgets and callbacks
    need no rewrite. Only the crowded horizontal tab strip is replaced by a
    stable left rail and a titled content area.
    """

    def __init__(self, root, toolkit, on_change=None):
        self.root = root
        self.tb = toolkit
        self.on_change = on_change
        self._pages = []
        self._buttons = {}
        self._selected = None
        self._titles = {}

        shell = toolkit.Frame(root, padding=(10, 2, 10, 8))
        shell.pack(fill="both", expand=True)
        self.sidebar = toolkit.Frame(shell, width=198, padding=(10, 12),
                                     relief="solid", borderwidth=1)
        self.sidebar.pack(side="left", fill="y", padx=(0, 10))
        self.sidebar.pack_propagate(False)

        toolkit.Label(self.sidebar, text="ED RING COLONY", foreground="#42b9d4",
                      font=("Segoe UI", 9, "bold")).pack(anchor="w", padx=8)
        toolkit.Label(self.sidebar, text="РАЗДЕЛЫ", foreground="#9ca3af",
                      font=("Consolas", 8, "bold")).pack(anchor="w", padx=8, pady=(2, 12))
        self.nav_items = toolkit.Frame(self.sidebar)
        self.nav_items.pack(fill="x")
        toolkit.Frame(self.sidebar).pack(fill="both", expand=True)
        toolkit.Label(self.sidebar, text="Журналы обрабатываются локально\nF12 — оверлей",
                      foreground="#9ca3af", justify="left", wraplength=166,
                      font=("Segoe UI", 8)).pack(anchor="w", padx=8, pady=(8, 2))

        self.workspace = toolkit.Frame(shell, relief="solid", borderwidth=1)
        self.workspace.pack(side="left", fill="both", expand=True)
        heading = toolkit.Frame(self.workspace, padding=(14, 10, 14, 8))
        heading.pack(fill="x")
        toolkit.Frame(self.workspace, height=2, bootstyle="warning").pack(fill="x", side="top")
        self.title_label = toolkit.Label(heading, text="", foreground="#eeeeee",
                                         font=("Segoe UI", 13, "bold"))
        self.title_label.pack(anchor="w")
        toolkit.Label(heading, text="ED RING COLONY  /  COMMAND DECK",
                      foreground="#42b9d4", font=("Consolas", 8, "bold")).pack(anchor="w", pady=(2, 0))
        self.content_area = toolkit.Frame(self.workspace)
        self.content_area.pack(fill="both", expand=True, padx=8, pady=(0, 8))

    def add(self, page, text: str) -> None:
        title = str(text).strip()
        self._pages.append(page)
        self._titles[page] = title
        button = self.tb.Button(
            self.nav_items, text=title, command=lambda p=page: self.select(p),
            bootstyle="secondary-outline", padding=(8, 6),
        )
        button.pack(fill="x", pady=2)
        self._buttons[page] = button

    def select(self, page=None):
        """Select a page, or return its Tk path like ``ttk.Notebook.select``."""
        if page is None:
            return str(self._selected) if self._selected is not None else ""
        if isinstance(page, str):
            page = next((candidate for candidate in self._pages
                         if str(candidate) == page), None)
            if page is None:
                return ""
        if page not in self._titles:
            return ""
        changed = page is not self._selected
        if not changed:
            return str(page)
        if self._selected is not None:
            try:
                self._selected.place_forget()
            except Exception:
                pass
        self._selected = page
        page.place(x=0, y=0, relwidth=1, relheight=1)
        self.title_label.configure(text=self._titles[page])
        for candidate, button in self._buttons.items():
            try:
                button.configure(bootstyle="warning" if candidate is page else "secondary-outline")
            except Exception:
                pass
        if callable(self.on_change):
            self.on_change()
        return str(page)
