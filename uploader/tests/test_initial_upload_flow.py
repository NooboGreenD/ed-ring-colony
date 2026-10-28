"""Сквозной smoke-тест первичной загрузки на настоящем Qt.

`colonial_helper.py` — GUI-приложение, но вся логика первичной загрузки
(`_do_upload_thread`) должна работать и без показа окна. Здесь строится
настоящий корень из Qt-виджетов, диалоги выключены (`ui_qt.DIALOGS_ENABLED`),
так что модальных окон никто не ждёт, а транспорт сайта подменён.

Проверяется главное: доставки и snapshots уходят на сайт пачками, история не
дёргает EDSM/Inara/Raven, повторный импорт тех же файлов ничего не делает.
"""

import json
import sys
import time
import unittest
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def install_gui_stubs():
    """Подготовить Qt к прогону: один QApplication, без модальных диалогов.

    Диалоги Helper теперь нативные (`ui_qt`); в прогоне они выключены —
    модальное окно ждало бы клика, которого нет. Тесты, которым важен ответ,
    подменяют `colonial_helper.ask_yes_no` и соседей сами.
    """
    import ui_qt

    ui_qt.ensure_app()
    ui_qt.DIALOGS_ENABLED = False


def restore_gui_stubs():
    """Вернуть диалоги остальным тестам (флаг общий на процесс)."""
    import ui_qt

    ui_qt.DIALOGS_ENABLED = True


#: Живые корни, созданные `make_root()` (см. ограничение в конструкторе).
_ROOTS = []


def make_root():
    """Лёгкий корень Helper для тестов: виджет без окна и без рамки.

    Приложению нужен объект с `body_layout` и небольшим набором методов
    (таймеры, буфер обмена, заголовок). Настоящее окно здесь не нужно: оно
    тянет за собой фильтры событий и оформление, а тесты проверяют логику.
    `after(0, …)` выполняется сразу — иначе тестам пришлось бы крутить цикл
    событий Qt.
    """
    from PySide6.QtWidgets import QVBoxLayout, QWidget

    from ui_qt import ensure_app

    ensure_app()

    class _TestRoot(QWidget):
        def __init__(self):
            super().__init__()
            # Держим живыми не больше двух корней: каждый следующий тест
            # строит своё приложение, а накопленные деревья виджетов потом
            # приходится перекрашивать/пересчитывать целиком.
            while len(_ROOTS) >= 2:
                old = _ROOTS.pop(0)
                try:
                    old.setParent(None)
                    old.deleteLater()
                except RuntimeError:
                    pass
            _ROOTS.append(self)
            self.body_layout = QVBoxLayout(self)
            self.body_layout.setContentsMargins(0, 0, 0, 0)
            self._title = "Colonial Helper"
            self._timers = {}
            self._seq = 0

        # --- окно -------------------------------------------------------
        def title(self, text=None):
            if text is not None:
                self._title = str(text)
            return self._title

        def geometry(self, spec=None):
            if spec is None:
                return "1180x790"
            return str(spec)

        def minsize(self, width, height):
            return None

        def iconbitmap(self, path):
            return None

        def winfo_width(self):
            return 1180

        def winfo_exists(self):
            return True

        def update_idletasks(self):
            return None

        def destroy(self):
            self._timers.clear()

        def protocol(self, name, handler):
            self._close_handler = handler

        def bind(self, sequence, handler, add=None):
            return None

        # --- буфер обмена ----------------------------------------------
        @property
        def _clipboard(self):
            from PySide6.QtGui import QGuiApplication

            return QGuiApplication.clipboard()

        def clipboard_clear(self):
            clipboard = self._clipboard
            if clipboard is not None:
                clipboard.clear()

        def clipboard_append(self, text):
            clipboard = self._clipboard
            if clipboard is not None:
                clipboard.setText(str(text))

        # --- таймеры ----------------------------------------------------
        def after(self, delay_ms, callback):
            if int(delay_ms) == 0 and callable(callback):
                callback()
                return "after#1"
            self._seq += 1
            token = self._seq
            self._timers[token] = callback
            return token

        def after_cancel(self, token):
            self._timers.pop(token, None)

    return _TestRoot()


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
        install_gui_stubs()
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
        restore_gui_stubs()
        try:
            self.tmp.cleanup()
        except OSError:
            import time
            time.sleep(0.15)
            try:
                self.tmp.cleanup()
            except OSError:
                pass

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
        # меньше, чем число файлов. Порог с запасом на загруженный CI-раннер:
        # регрессия, ради которой написан тест, измерялась минутами.
        self.assertLess(elapsed, 60.0)

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

    def test_live_ticks_do_not_resend_unchanged_depot_state(self):
        """Живой тик не отправляет то же состояние стройки второй раз.

        Журнал пишет `ColonisationConstructionDepot` каждые несколько секунд,
        пока игрок стоит у площадки, а состояние меняется редко. Коллектор
        отсева создавался заново на каждый тик (и на каждый файл), поэтому его
        набор подписей терялся: на сайт уходила примерно одна строка на тик —
        тысячи строк об одном состоянии вместо одного изменения.
        """
        app = self._build_app()
        self._reset_import_state(app)
        app._watcher_cmdr_name = "Test CMDR"

        path = self.journal_dir / "Journal.2026-09-14T100000.01.log"
        location = json.dumps({
            "timestamp": "2026-09-14T10:00:00Z",
            "event": "Location",
            "StarSystem": "Delta Velorum",
            "SystemAddress": 6474796828161,
        }, ensure_ascii=False)

        def depot(second):
            return json.dumps({
                "timestamp": "2026-09-14T10:00:%02dZ" % second,
                "event": "ColonisationConstructionDepot",
                "MarketID": 3951663874,
                "ConstructionID": 7,
                "ConstructionName": "Ditceford Hub",
                "ConstructionProgress": 0.5,
                "ResourcesRequired": [
                    {"Name": "$steel_name;", "RequiredAmount": 5000, "ProvidedAmount": 1200},
                ],
            }, ensure_ascii=False)

        # Первый тик: площадка, состояние которой не меняется.
        path.write_text("\n".join([location] + [depot(s) for s in range(0, 10, 5)]) + "\n", encoding="utf-8")
        first_size = path.stat().st_size
        self.assertEqual(app._process_journal_changes(path, 0, first_size, live=True), first_size)

        # Второй тик: журнал дописал ещё три события с тем же состоянием.
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(depot(s) for s in (15, 20, 25)) + "\n")
        second_size = path.stat().st_size
        self.assertEqual(
            app._process_journal_changes(path, first_size, second_size, live=True),
            second_size - first_size,
        )

        rows = [row for chunk in self.uploads["construction"] for row in chunk]
        self.assertEqual(
            len(rows), 1,
            "неизменившееся состояние стройки ушло на сайт повторно: %d строк" % len(rows),
        )

        # Настоящее изменение состояния обязано уйти на сайт.
        with open(path, "a", encoding="utf-8") as fh:
            changed = json.loads(depot(30))
            changed["ConstructionProgress"] = 0.62
            fh.write(json.dumps(changed, ensure_ascii=False) + "\n")
        third_size = path.stat().st_size
        app._process_journal_changes(path, second_size, third_size, live=True)
        rows = [row for chunk in self.uploads["construction"] for row in chunk]
        self.assertEqual(len(rows), 2, "изменившееся состояние отброшено как повтор")

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
