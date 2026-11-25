"""Coloniser loading-pattern tab. Network work runs outside the GUI thread."""

import threading
import time
import webbrowser
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QComboBox,
    QProgressBar,
    QPlainTextEdit,
)
from i18n import tr
from loading_patterns import LoadingPatternState, loading_lines


class LoadingPatternsPage(QWidget):
    received = Signal(int, object, object, str)

    def __init__(self, api, config, save, overlay_active, parent=None):
        super().__init__(parent)
        self.api, self.config, self.save, self.overlay_active = (
            api,
            config,
            save,
            overlay_active,
        )
        self.state = LoadingPatternState()
        self.active_id = str(config.get("loading_pattern_id") or "")
        self.focus_id = ""
        self._identity = self.identity()
        self.state.clear(self._identity, self.active_id)
        self._seq, self._busy, self._last = 0, False, 0.0
        layout = QVBoxLayout(self)
        info = QLabel(
            tr(
                "Паттерны погрузки: Архитектор → Погрузка. Остатки — учёт сайта, не полный снимок игры."
            )
        )
        info.setWordWrap(True)
        layout.addWidget(info)
        bar = QHBoxLayout()
        self.scope = QComboBox()
        self.scope.addItem(tr("Мои паттерны"), "mine")
        self.scope.addItem(tr("Публичные паттерны"), "public")
        self.patterns = QComboBox()
        self.patterns.setMinimumWidth(190)
        self.refresh_button = QPushButton(tr("Обновить"))
        self.refresh_button.clicked.connect(lambda: self.refresh(True, True))
        self.apply_button = QPushButton(tr("Применить паттерн"))
        self.apply_button.clicked.connect(self.apply)
        self.clear_button = QPushButton(tr("Отключить паттерн"))
        self.clear_button.clicked.connect(self.clear)
        for widget in (
            self.scope,
            self.patterns,
            self.refresh_button,
            self.apply_button,
            self.clear_button,
        ):
            bar.addWidget(widget)
        layout.addLayout(bar)
        self.scope.currentIndexChanged.connect(lambda: self.refresh(True, True))
        self.status = QLabel("")
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        controls = QHBoxLayout()
        self.focus = QComboBox()
        self.focus.addItem(tr("Все авианосцы"), "")
        self.focus.currentIndexChanged.connect(self.focus_changed)
        site = QPushButton(tr("Открыть паттерны на сайте"))
        site.clicked.connect(self.open_site)
        controls.addWidget(self.focus)
        controls.addWidget(site)
        layout.addLayout(controls)
        self.bar = QProgressBar()
        self.bar.setRange(0, 1000)
        layout.addWidget(self.bar)
        self.details = QPlainTextEdit()
        self.details.setReadOnly(True)
        layout.addWidget(self.details, 1)
        self.received.connect(self.apply_result)
        self.timer = QTimer(self)
        self.timer.setInterval(5000)
        self.timer.timeout.connect(self.tick)
        self.timer.start()

    def focus_changed(self):
        self.focus_id = str(self.focus.currentData() or "")
        self.render()

    def identity(self):
        return (
            str(getattr(self.api, "api_base", "")),
            str(getattr(self.api, "token", "")),
            bool(getattr(self.api, "is_connected", False)),
        )

    def showEvent(self, event):
        super().showEvent(event)
        self.refresh(True)

    def open_site(self):
        base = str(self.api.api_base).removesuffix("/api")
        webbrowser.open(
            base
            + "/architect/loading"
            + ("?pattern=" + self.active_id if self.active_id else "")
        )

    def apply(self):
        value = self.patterns.currentData()
        if not value:
            return
        self.active_id = str(value)
        self.config["loading_pattern_id"] = self.active_id
        self.save()
        self.state.clear(self.identity(), self.active_id)
        self.refresh(False, True)

    def clear(self):
        self._seq += 1
        self._busy = False
        self.active_id = ""
        self.config.pop("loading_pattern_id", None)
        self.save()
        self.state.clear(self.identity(), "")
        self.render()

    def tick(self):
        identity = self.identity()
        if identity != self._identity:
            if identity[:2] != self._identity[:2]:
                self.active_id = ""
                self.config.pop("loading_pattern_id", None)
                self.save()
            self._identity = identity
            self._seq += 1
            self._busy = False
            self.state.clear(identity, self.active_id)
            self.patterns.clear()
            self.focus.clear()
            self.focus.addItem(tr("Все авианосцы"), "")
            self.focus_id = ""
            self.render()
        if (
            self.isVisible() or (self.active_id and self.overlay_active())
        ) and time.monotonic() - self._last >= 30:
            self.refresh(self.isVisible())

    def refresh(self, include_list=False, force=False):
        if self._busy and not force:
            return
        self._seq += 1
        seq = self._seq
        identity = self.identity()
        pattern_id = self.active_id
        self._last = time.monotonic()
        self._busy = True
        self.state.prepare(identity, pattern_id)
        scope = self.scope.currentData() or "mine"

        def worker():
            listing, detail = None, None
            try:
                if not identity[1] or not identity[2]:
                    detail = {"ok": False, "error": tr("Нет подключения к сайту")}
                else:
                    if include_list:
                        listing = self.api.fetch_loading_patterns(scope=scope)
                    if pattern_id:
                        detail = self.api.fetch_loading_pattern(pattern_id)
            except Exception:
                detail = {"ok": False, "error": tr("Не удалось загрузить паттерн")}
            try:
                self.received.emit(seq, listing, detail, pattern_id)
            except RuntimeError:
                pass  # Widget was destroyed while a request completed.

        threading.Thread(target=worker, name="loading-patterns", daemon=True).start()

    def apply_result(self, seq, listing, detail, pattern_id):
        if seq != self._seq:
            return
        self._busy = False
        if self.identity() != self.state.identity:
            return
        if listing is not None:
            self.patterns.clear()
            if listing.get("ok"):
                for row in listing.get("patterns") or []:
                    self.patterns.addItem(
                        f"{row['pattern']['name']} · {row.get('author', '')}", row["id"]
                    )
                index = self.patterns.findData(self.active_id)
                if index >= 0:
                    self.patterns.setCurrentIndex(index)
            else:
                self.status.setText(
                    str(listing.get("error") or tr("Не удалось загрузить паттерн"))
                )
        if detail is not None:
            self.state.accept(self.identity(), pattern_id, detail)
            self.focus.blockSignals(True)
            self.focus.clear()
            self.focus.addItem(tr("Все авианосцы"), "")
            for carrier in (detail.get("progress") or {}).get("carriers") or []:
                self.focus.addItem(carrier["name"], carrier["carrierId"])
            index = self.focus.findData(self.focus_id)
            self.focus.setCurrentIndex(max(0, index))
            self.focus_id = str(self.focus.currentData() or "")
            self.focus.blockSignals(False)
        self.render()

    def overlay_state(self):
        # Called by the existing HUD collector: no Qt calls, disk or network IO.
        return self.state.snapshot(self.identity(), self.active_id, self.focus_id)

    def render(self):
        data = self.overlay_state()
        progress = data.get("progress") or {}
        if not progress:
            self.bar.setValue(0)
            self.details.clear()
            self.status.setText(data.get("note") or tr("Паттерн не выбран"))
            return
        name = (data.get("pattern") or {}).get("pattern", {}).get("name", "")
        loaded, total = progress.get("loaded", 0), progress.get("total", 0)
        self.status.setText(
            f"{name} · {loaded} / {total} t · ? {progress.get('unknown', 0)} t · {data.get('checkedAt', '')}"
        )
        if (data.get("pattern") or {}).get("catalogueUpdated"):
            self.status.setText(self.status.text() + "\n" + tr("Каталог обновлён: проверьте распределение на сайте."))
        self.bar.setValue(int(1000 * loaded / max(1, total)))
        summaries, rows = loading_lines(data, True)
        self.details.setPlainText("\n".join(summaries + [""] + rows))
