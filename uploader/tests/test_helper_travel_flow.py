"""Тесты вкладки «Путешествия» на уровне приложения: слежение и буфер обмена.

Страница умеет только рисовать. Всё остальное — определение позиции пилота,
копирование следующей системы, замеры прыжков и сброс — живёт в
`colonial_helper`. Здесь проверяется именно эта связка, но без окна: берётся
экземпляр приложения без `__init__` (он тянет Qt-окно, журнал и сеть), и все
нужные атрибуты подставляются руками.

Главное правило: буфер обмена обновляется, только когда меняется САМА
следующая система. Иначе тик каждые 15 секунд затирал бы всё, что пилот
скопировал для себя.
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    import colonial_helper
    import helper_pages
    import route_travel
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


class FakeRoot:
    """Корень окна: запоминает, что положили в буфер обмена."""

    def __init__(self):
        self.clipboard = []

    def clipboard_clear(self):
        self.clipboard.clear()

    def clipboard_append(self, text):
        self.clipboard.append(str(text))

    def after(self, _ms, _callback=None):
        return None


class FakeShipState:
    """Состояние корабля так, как его видит приложение (`ship.state`)."""

    def __init__(self, system=""):
        self.current_system = system

    def move_to(self, system):
        self.current_system = system


class FakeShip:
    def __init__(self, system=""):
        self.state = FakeShipState(system)


class FakeApi:
    """Клиент сайта: подсказку о системе подменяем, в сеть не идём."""

    def __init__(self):
        self.hint_calls = []

    def get_route_hint(self, name):
        self.hint_calls.append(name)
        return {"ok": True, "system": name}


class FakeOverlay:
    def __init__(self):
        self.lines = []

    def log(self, message, level="info"):
        self.lines.append((level, message))


def make_app(current_system="Alpha Centauri"):
    """Собранное «приложение» без запуска окна: только нужные атрибуты."""
    from route_tracker import RouteTracker

    app = colonial_helper.ColonialHelperApp.__new__(colonial_helper.ColonialHelperApp)
    app.route = RouteTracker()
    app.travel_session = route_travel.TravelSession()
    app._travel_follow = False
    app._travel_last_copied = ""
    app._travel_last_state = {}
    app._travel_hint_name = ""
    app._travel_hint_at = 0.0
    app.root = FakeRoot()
    app.ship = FakeShip(current_system)
    app.overlay_manager = FakeOverlay()
    app.api = FakeApi()
    app.log_lines = []
    app.after_calls = []
    app.log = lambda message, level="info": app.log_lines.append((level, str(message)))
    app.after = lambda ms, callback=None: app.after_calls.append(ms)
    app._travel_hint_requested = []
    app.route.refresh_system_hint = (
        lambda fetch=None, force=False: app._travel_hint_requested.append(force))
    app.travel_page = helper_pages.TravelPage()
    app.route_page = helper_pages.RoutePage()
    return app


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class TravelApplicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app_qt = ensure_app()

    def setUp(self):
        import i18n

        i18n.set_locale("ru")
        self.app = make_app()

    def tearDown(self):
        import i18n

        i18n.set_locale("ru")
        page = getattr(self.app, "travel_page", None)
        if page is not None:
            page.deleteLater()

    # ------------------------------------------------------------- accepting
    def test_accepts_a_plain_list(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.assertEqual([s["name"] for s in self.app.route.systems],
                         ["Sol", "Alpha Centauri", "Wolf 359"])
        # Пилот сейчас в Alpha Centauri — система отмечена пройденной.
        self.assertEqual(self.app.route.systems[1]["status"], "visited")
        self.assertEqual(self.app.travel_page.status_label.text() != "", True)

    def test_accepts_navroute_json(self):
        self.app._travel_accept('{"Route": [{"StarSystem": "Sol"}, '
                                '{"StarSystem": "Wolf 359"}]}')
        self.assertEqual(len(self.app.route.systems), 2)
        self.assertEqual(self.app.route.systems[0]["name"], "Sol")

    def test_accepts_csv_through_the_tracker(self):
        self.app._travel_accept("Система;Статус\nSol;Посещена\nWolf 359;Ожидает\n")
        self.assertEqual([s["name"] for s in self.app.route.systems],
                         ["Sol", "Wolf 359"])

    def test_bad_text_is_reported_not_accepted(self):
        self.app._travel_accept('{"a": 1}')
        self.assertEqual(self.app.route.systems, [])
        self.assertTrue(any(level == "error" for level, _text in self.app.log_lines))

    def test_accept_restarts_the_journey_clock(self):
        self.app.travel_session.record("Sol", at=100.0)
        self.app._travel_accept("Sol\nWolf 359")
        self.assertEqual(self.app.travel_session.jumps, [],
                         "замеры прошлого маршрута к новому не относятся")

    def test_accept_asks_for_the_hint_of_the_next_system(self):
        self.app._travel_accept("Sol\nWolf 359")
        self.assertTrue(self.app._travel_hint_requested, "подсказка запрошена")
        self.assertEqual(self.app._travel_hint_requested[0], False)

    def test_paste_keeps_the_text_when_it_could_not_be_read(self):
        """Нераспознанный текст остаётся в поле: его надо поправить, а не искать заново."""
        text = '{"Route": ['
        self.app.travel_page.set_route_text(text)
        self.app._on_travel_paste()
        self.assertEqual(self.app.travel_page.route_text(), text)

    def test_paste_clears_the_field_after_success(self):
        self.app.travel_page.set_route_text("Sol\nAlpha Centauri\nWolf 359")
        self.app._on_travel_paste()
        self.assertEqual(self.app.travel_page.route_text(), "")
        self.assertEqual(len(self.app.route.systems), 3)

    def test_route_file_is_read_and_named_in_the_log(self):
        """Файл маршрута читается с диска, имя файла попадает в журнал."""
        import tempfile

        import colonial_helper as module

        self.app._travel_accept  # приём тот же, что у вставки
        original = module.ask_open_file
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                        encoding="utf-8") as handle:
            handle.write("Sol\nWolf 359\n")
            path = handle.name
        try:
            module.ask_open_file = lambda **kwargs: path
            self.app._on_travel_load_file()
        finally:
            module.ask_open_file = original
        self.assertEqual([s["name"] for s in self.app.route.systems], ["Sol", "Wolf 359"])
        self.assertTrue(any("источник" in text for _level, text in self.app.log_lines))

    def test_cancelled_file_dialog_changes_nothing(self):
        import colonial_helper as module

        original = module.ask_open_file
        try:
            module.ask_open_file = lambda **kwargs: ""
            self.app._on_travel_load_file()
        finally:
            module.ask_open_file = original
        self.assertEqual(self.app.route.systems, [])
        self.assertEqual(self.app.log_lines, [])

    # --------------------------------------------------------------- following
    def test_following_copies_the_next_system(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._on_travel_follow_changed(True)
        self.assertEqual(self.app.root.clipboard[-1], "Wolf 359")
        self.assertTrue(self.app.travel_page.is_following())

    def test_following_is_off_by_default(self):
        self.app._travel_accept("Sol\nWolf 359")
        self.assertEqual(self.app.root.clipboard, [])
        self.assertFalse(self.app.travel_page.is_following())

    def test_jump_moves_the_clipboard_to_the_next_system(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359\nShinrarta Dezhra")
        self.app._on_travel_follow_changed(True)
        self.assertEqual(self.app.root.clipboard[-1], "Wolf 359")
        # Прыжок: сначала журнал сообщает новую систему (её же видит трекер
        # корабля), затем приходит событие — «следующая» меняется сразу.
        self.app.ship.state.move_to("Wolf 359")
        self.app._travel_note_jump("Wolf 359")
        self.assertEqual(self.app.root.clipboard[-1], "Shinrarta Dezhra")

    def test_repeated_system_does_not_touch_the_clipboard(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._on_travel_follow_changed(True)
        copies = len(self.app.root.clipboard)
        # Стыковка в той же системе — не прыжок.
        self.app._travel_note_jump("Wolf 359")
        self.app._travel_note_jump("Wolf 359")
        self.assertEqual(len(self.app.root.clipboard), copies)

    def test_manual_copy_works_without_following(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._on_travel_copy_next()
        self.assertEqual(self.app.root.clipboard[-1], "Wolf 359")

    def test_manual_copy_without_route_is_harmless(self):
        self.app._on_travel_copy_next()
        self.assertEqual(self.app.root.clipboard, [])
        self.assertTrue(any(level == "warn" for level, _text in self.app.log_lines))

    def test_following_off_stops_the_clipboard(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359\nShinrarta Dezhra")
        self.app._on_travel_follow_changed(True)
        self.app._on_travel_follow_changed(False)
        copies = len(self.app.root.clipboard)
        self.app._travel_note_jump("Wolf 359")
        self.assertEqual(len(self.app.root.clipboard), copies)

    # -------------------------------------------------------------- lifecycle
    def test_restart_resets_the_measurements(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._travel_note_jump("Sol")
        self.app._on_travel_restart()
        self.assertEqual(self.app.travel_session.jumps, [])
        self.assertIsNotNone(self.app.travel_session.started_at)

    def test_clear_removes_the_route_everywhere(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._on_travel_clear()
        self.assertEqual(self.app.route.systems, [])
        self.assertFalse(self.app.travel_page.copy_btn.isEnabled())
        self.assertEqual(self.app.travel_page.route_text(), "")

    def test_tick_keeps_the_timer_alive(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.app._travel_tick()
        self.assertIn(15000, self.app.after_calls)

    def test_state_survives_a_missing_page(self):
        app = make_app()
        app.travel_page = None
        app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        state = app._refresh_travel()
        self.assertTrue(state["loaded"])

    def test_current_system_comes_from_the_ship_tracker(self):
        self.app._travel_accept("Sol\nAlpha Centauri\nWolf 359")
        self.assertEqual(self.app._travel_current_system(), "Alpha Centauri")
        state = self.app._refresh_travel()
        self.assertEqual(state["stats"]["current"], "Alpha Centauri")


if __name__ == "__main__":
    unittest.main()
