"""Launcher-inspired sidebar navigation for the Colonial Helper desktop UI."""
from __future__ import annotations


class SidebarNavigator:
    """Page switcher that preserves the old Notebook.select() contract.

    Pages remain their original Tk frames; this class owns presentation and
    navigation only, so feature callbacks and data flows stay untouched.
    """

    def __init__(self, root, toolkit, on_change=None):
        self.root = root
        self.tb = toolkit
        self.on_change = on_change
        self._pages = []
        self._buttons = {}
        self._markers = {}
        self._selected = None
        self._titles = {}

        shell = toolkit.Frame(root, style="App.TFrame", padding=(14, 2, 14, 10))
        shell.pack(fill="both", expand=True)
        self.sidebar = toolkit.Frame(
            shell, width=214, padding=(12, 16), style="Sidebar.TFrame",
        )
        self.sidebar.pack(side="left", fill="y", padx=(0, 12))
        self.sidebar.pack_propagate(False)

        brand = toolkit.Frame(self.sidebar, style="Sidebar.TFrame")
        brand.pack(fill="x", padx=4, pady=(2, 18))
        toolkit.Frame(brand, width=3, style="Accent.TFrame").pack(
            side="left", fill="y", padx=(0, 10))
        brand_text = toolkit.Frame(brand, style="Sidebar.TFrame")
        brand_text.pack(side="left", fill="x", expand=True)
        toolkit.Label(brand_text, text="ED RING COLONY", style="Brand.TLabel",
                      font=("Segoe UI", 9, "bold")).pack(anchor="w")
        toolkit.Label(brand_text, text="SHIP SYSTEMS  /  DESKTOP",
                      style="SidebarMeta.TLabel",
                      font=("Consolas", 7, "bold")).pack(anchor="w", pady=(3, 0))

        toolkit.Label(self.sidebar, text="РАЗДЕЛЫ", style="SidebarMeta.TLabel",
                      font=("Segoe UI", 8, "bold")).pack(anchor="w", padx=8, pady=(0, 8))
        self.nav_items = toolkit.Frame(self.sidebar, style="Sidebar.TFrame")
        self.nav_items.pack(fill="x")
        toolkit.Frame(self.sidebar, style="Sidebar.TFrame").pack(fill="both", expand=True)
        toolkit.Separator(self.sidebar, orient="horizontal").pack(fill="x", padx=6, pady=(8, 10))
        toolkit.Label(self.sidebar, text="Журналы анализируются локально\nF12 — оверлей",
                      style="SidebarMeta.TLabel", justify="left", wraplength=176,
                      font=("Segoe UI", 8)).pack(anchor="w", padx=8, pady=(0, 2))

        self.workspace = toolkit.Frame(shell, style="Workspace.TFrame")
        self.workspace.pack(side="left", fill="both", expand=True)
        heading = toolkit.Frame(self.workspace, padding=(18, 13, 18, 12),
                                style="WorkspaceHeader.TFrame")
        heading.pack(fill="x")
        header_row = toolkit.Frame(heading, style="WorkspaceHeader.TFrame")
        header_row.pack(fill="x")
        self.title_label = toolkit.Label(
            header_row, text="", style="WorkspaceTitle.TLabel",
            font=("Segoe UI", 14, "bold"),
        )
        self.title_label.pack(side="left", anchor="w")
        toolkit.Label(header_row, text="LIVE  /  COMMAND DECK",
                      style="WorkspaceMeta.TLabel",
                      font=("Consolas", 8, "bold")).pack(side="right", anchor="e")
        toolkit.Label(heading, text="ED RING COLONY   /   ПАНЕЛЬ УПРАВЛЕНИЯ",
                      style="WorkspaceMeta.TLabel",
                      font=("Consolas", 8)).pack(anchor="w", pady=(4, 0))
        toolkit.Separator(self.workspace, orient="horizontal").pack(fill="x")
        self.content_area = toolkit.Frame(
            self.workspace, style="WorkspaceContent.TFrame", padding=(12, 10),
        )
        self.content_area.pack(fill="both", expand=True)

    def add(self, page, text: str) -> None:
        title = str(text).strip()
        self._pages.append(page)
        self._titles[page] = title
        row = self.tb.Frame(self.nav_items, style="Sidebar.TFrame")
        row.pack(fill="x", pady=2)
        marker = self.tb.Frame(row, width=3, style="NavMarker.TFrame")
        marker.pack(side="left", fill="y", padx=(0, 6))
        marker.pack_propagate(False)
        button = self.tb.Button(
            row, text=title, command=lambda p=page: self.select(p),
            bootstyle="secondary-outline", style="Navigation.TButton",
            padding=(9, 7),
        )
        button.pack(side="left", fill="x", expand=True)
        self._buttons[page] = button
        self._markers[page] = marker

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
        if page is self._selected:
            return str(page)
        if self._selected is not None:
            try:
                self._selected.pack_forget()
            except Exception:
                self._selected.hide()
        self._selected = page
        page.pack(fill="both", expand=True)
        page.show()
        self.title_label.configure(text=self._titles[page])
        for candidate, button in self._buttons.items():
            selected = candidate is page
            try:
                button.configure(bootstyle="warning" if selected else "secondary-outline")
                self._markers[candidate].configure(
                    style="Accent.TFrame" if selected else "NavMarker.TFrame")
            except Exception:
                pass
        if callable(self.on_change):
            self.on_change()
        return str(page)
