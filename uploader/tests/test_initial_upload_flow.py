"""Сквозной smoke-тест первичной загрузки без настоящего Tk.

`colonial_helper.py` — GUI-приложение, но вся логика первичной загрузки
(`_do_upload_thread`) должна работать и без реального окна. Здесь tkinter и
ttkbootstrap подменяются заглушками, приложение конструируется, и реальный
поток загрузки прогоняется на синтетических журналах с подменённым
транспортом сайта.

Проверяется главное: доставки и snapshots уходят на сайт пачками, история не
дёргает EDSM/Inara/Raven, повторный импорт тех же файлов ничего не делает.
"""

import sys
import time
import types
import unittest
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


# ---------------------------------------------------------------------------
# Заглушки tkinter / ttkbootstrap / pyperclip
# ---------------------------------------------------------------------------
class _ConstantsModule(types.ModuleType):
    """Модуль, отдающий строковую константу для любого имени (LEFT, BOTH, ...)."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return str(name)


class _FakeModule(types.ModuleType):
    """Модуль-заглушка: любой атрибут — MagicMock."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        value = mock.MagicMock(name=name)
        setattr(self, name, value)
        return value


def install_gui_stubs():
    for name in ("tkinter", "ttkbootstrap", "ttkbootstrap.constants",
                 "ttkbootstrap.scrolled", "pyperclip"):
        sys.modules.pop(name, None)

    tkinter_stub = _FakeModule("tkinter")
    sys.modules["tkinter"] = tkinter_stub

    # Tk-переменные должны хранить реальные значения (tk.DoubleVar и т.п.).
    class _TkVar:
        def __init__(self, master=None, value=None, name=None):
            self._value = value

        def get(self):
            return self._value

        def set(self, value):
            self._value = value

        def trace_add(self, *args, **kwargs):
            return ""

    for var_name in ("BooleanVar", "IntVar", "DoubleVar", "StringVar", "Variable"):
        setattr(tkinter_stub, var_name, _TkVar)

    ttkbootstrap_stub = _FakeModule("ttkbootstrap")
    constants_stub = _ConstantsModule("ttkbootstrap.constants")
    scrolled_stub = _FakeModule("ttkbootstrap.scrolled")

    # Переменные Tk должны хранить реальные значения: по ним форматируются
    # подписи ({alpha_var.get():.0%}) и читаются галочки.
    class _Var:
        def __init__(self, master=None, value=None, name=None):
            self._value = value

        def get(self):
            return self._value

        def set(self, value):
            self._value = value

        def trace_add(self, *args, **kwargs):
            return ""

    for var_name in ("BooleanVar", "IntVar", "DoubleVar", "StringVar", "Variable"):
        setattr(ttkbootstrap_stub, var_name, _Var)

    def ScrolledText(*args, **kwargs):
        # Важно вернуть именно MagicMock: app обращается к log_text.text.<...>
        widget = mock.MagicMock(name="ScrolledText")
        widget.text = mock.MagicMock(name="ScrolledText.text")
        return widget

    scrolled_stub.ScrolledText = ScrolledText
    ttkbootstrap_stub.constants = constants_stub
    ttkbootstrap_stub.scrolled = scrolled_stub
    sys.modules["ttkbootstrap"] = ttkbootstrap_stub
    sys.modules["ttkbootstrap.constants"] = constants_stub
    sys.modules["ttkbootstrap.scrolled"] = scrolled_stub
    sys.modules["pyperclip"] = _FakeModule("pyperclip")

    # `from ttkbootstrap.constants import *` требует непустой __all__.
    # Значения берутся из __getattr__ заглушки (любое имя -> строка).
    constants_stub.__all__ = (
        "LEFT", "RIGHT", "TOP", "BOTTOM", "BOTH", "X", "Y", "N", "S", "E", "W",
        "NE", "NW", "SE", "SW", "CENTER", "END", "NORMAL", "DISABLED", "ACTIVE",
        "VERTICAL", "HORIZONTAL", "WORD", "CHAR", "NONE", "SOLID", "RAISED",
        "TRUE", "FALSE", "READONLY", "HIDDEN",
    )
    return ttkbootstrap_stub


def make_root():
    """Корневое окно: after(0, cb) выполняется сразу, остальные — в никуда.

    Отложенные вызовы (например, автообновление инфографики раз в секунду)
    не выполняются, иначе заглушка ушла бы в бесконечную рекурсию.
    """
    root = mock.MagicMock(name="root")
    root.winfo_exists.return_value = True

    def after(ms, callback=None, *args):
        if ms == 0 and callable(callback):
            callback(*args)
        return "after#1"

    root.after.side_effect = after
    return root


# ---------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, payload, status=200):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = "{}"
        self._payload = payload

    def json(self):
        return self._payload


class UploadFlowTests(unittest.TestCase):
    def setUp(self):
        self.stub = install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch",
                     "journal_parser", "overlay", "ship_tracker", "route_tracker",
                     "game_monitor", "exobiology"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

        from tests.test_upload_performance import make_history  # noqa: E402
        self.journal_dir = self.home / "journals"
        self.files = make_history(self.journal_dir, files=5, events_per_file=300)

    def tearDown(self):
        self.tmp.cleanup()

    def _build_app(self):
        import colonial_helper  # noqa: E402

        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.journal_dir):
            with mock.patch("pathlib.Path.home", return_value=self.home):
                app = colonial_helper.ColonialHelperApp(make_root())
        app.api.token = "token"
        app.api.user_id = "user-1"
        app.journal_path = self.journal_dir

        # Транспорт сайта: считаем пачки, ничего не отправляя.
        self.uploads = {"deliveries": [], "construction": []}

        def fake_post(payload, timeout=30):
            if "deliveries" in payload:
                rows = payload["deliveries"]
                self.uploads["deliveries"].append(rows)
                data = {"inserted": len(rows), "eventsFound": 0}
            else:
                rows = payload.get("construction_events", [])
                self.uploads["construction"].append(rows)
                data = {"constructionInserted": len(rows), "snapshotInserted": len(rows)}
            return _FakeResponse(data), data

        app.api._post_upload = fake_post
        return app

    def _reset_import_state(self, app):
        """Чистый старт: без кэша импорта и без сохранённых смещений."""
        app.imported_files = {}
        app.skip_imported_files = True
        app._seen_events = set()
        app._last_cargo = {}
        app._last_depot_state = {}
        app._last_contribution_state = {}
        app._defer_uploads = False
        app._backfill_deliveries = []
        app._backfill_construction = []

    def test_initial_upload_flow_end_to_end(self):
        app = self._build_app()
        self._reset_import_state(app)
        app.selected_files = list(self.files)

        # Засекаем и прогоняем реальный поток загрузки (синхронно).
        started = time.monotonic()
        app._do_upload_thread()
        elapsed = time.monotonic() - started

        delivery_rows = [row for chunk in self.uploads["deliveries"] for row in chunk]
        construction_rows = [row for chunk in self.uploads["construction"] for row in chunk]

        self.assertTrue(delivery_rows, "доставки должны уйти на сайт")
        self.assertTrue(construction_rows, "snapshots стройки должны уйти на сайт")

        # Пачки не больше лимитов сервера (100 snapshots / 500 доставок).
        self.assertTrue(all(len(c) <= 100 for c in self.uploads["construction"]))
        self.assertTrue(all(len(c) <= 500 for c in self.uploads["deliveries"]))

        # Внешние API историей не дёргаются.
        stats = app.dispatcher.snapshot_stats()
        self.assertEqual(stats["queued"], 0)
        self.assertGreater(stats["skipped_backfill"], 0)

        # Все файлы помечены загруженными.
        self.assertEqual(len(app.imported_files), len(self.files))
        self.assertTrue(all(app._is_file_imported(p) for p in self.files))

        # Быстро: сеть подменена, но и на реальной сети пачек стало на порядок
        # меньше, чем число файлов.
        self.assertLess(elapsed, 30.0)

    def test_second_import_skips_unchanged_files(self):
        app = self._build_app()
        self._reset_import_state(app)
        app.selected_files = list(self.files)

        app._do_upload_thread()
        first_delivery_chunks = len(self.uploads["deliveries"])
        self.assertGreater(first_delivery_chunks, 0)

        # Вторая загрузка тех же файлов: всё пропускается, запросов нет.
        self.uploads["deliveries"].clear()
        self.uploads["construction"].clear()
        app._do_upload_thread()
        self.assertEqual(self.uploads["deliveries"], [])
        self.assertEqual(self.uploads["construction"], [])

    def test_changed_file_is_reimported(self):
        app = self._build_app()
        self._reset_import_state(app)
        app.selected_files = list(self.files)
        app._do_upload_thread()

        # Дописываем в конец файла — он должен быть разобран заново.
        target = self.files[0]
        with open(target, "a", encoding="utf-8") as fh:
            fh.write('{"timestamp":"2025-06-01T10:00:00Z","event":"Music","MusicTrack":"X"}\n')
        self.assertFalse(app._is_file_imported(target))
        self.assertTrue(all(app._is_file_imported(p) for p in self.files[1:]))

    def test_reset_cache_allows_reimport(self):
        app = self._build_app()
        self._reset_import_state(app)
        app.selected_files = list(self.files)
        app._do_upload_thread()
        self.assertEqual(len(app.imported_files), len(self.files))

        app._reset_import_cache()
        self.assertEqual(app.imported_files, {})
        self.uploads["deliveries"].clear()
        app._do_upload_thread()
        self.assertTrue(self.uploads["deliveries"])

    def test_watcher_reconciliation_batches_site_uploads(self):
        """Первичная сверка watcher'а копит данные и отправляет их одним пакетом."""
        app = self._build_app()
        self._reset_import_state(app)
        app.api.user_id = "user-1"

        app._defer_uploads = True
        for path in self.files:
            size = path.stat().st_size
            processed = app._process_journal_changes(path, 0, size, live=False)
            self.assertEqual(processed, size)
        # Во время сверки на сайт не уходит ничего.
        self.assertEqual(self.uploads["deliveries"], [])
        self.assertEqual(self.uploads["construction"], [])

        app._flush_deferred_uploads()
        rows = [row for chunk in self.uploads["deliveries"] for row in chunk]
        self.assertTrue(rows, "накопленные доставки должны отправиться одним пакетом")
        self.assertFalse(app._defer_uploads)
        self.assertEqual(app._backfill_deliveries, [])

    def test_live_tick_sends_events_to_third_party(self):
        """Обычный тик watcher'а (live=True) по-прежнему кормит внешние API."""
        app = self._build_app()
        self._reset_import_state(app)

        class FakeEdsm:
            enabled = True

            def __init__(self):
                self.calls = 0

            def submit_event(self, event):
                self.calls += 1
                return {"ok": True}

        fake_edsm = FakeEdsm()
        app.edsm_api = fake_edsm
        app.dispatcher.configure(edsm_api=fake_edsm)

        app._watcher_cmdr_name = "Test CMDR"
        path = self.files[0]
        app._process_journal_changes(path, 0, path.stat().st_size, live=True)
        app.dispatcher.flush(timeout=2)
        self.assertGreater(fake_edsm.calls, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
