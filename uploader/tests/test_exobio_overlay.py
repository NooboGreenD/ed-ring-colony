"""Тесты оверлея EXOBIO: образцы с отсчётом, роды с процентом, тела системы.

Жалоба: «требуется улучшить оверлей Exobio». Блок показывал тело, параметры,
биосигналы, до шести родов «решётками» и список образцов. Добавлено:

* прогресс образцов ●●○ 2/3 и обратный отсчёт до следующего снимка;
* одна строка-подсказка «что делать сейчас»;
* оценка выплаты в кр (порядок величины, по роду);
* роды с процентом совпадения правил и причиной, а не «######»;
* список тел системы с биосигналами — куда лететь.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_management import _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()

from overlay import ExobiologyOverlay  # noqa: E402
from test_overlay_layout import _FakeMaster  # noqa: E402


class _Master(_FakeMaster):
    """Tk-заглушка, которая запоминает отложенные вызовы, а не исполняет их."""

    def __init__(self):
        super().__init__()
        self.scheduled = []
        self.cancelled = []

    def after(self, delay, callback=None):
        self.scheduled.append((delay, callback))
        return f"after-{len(self.scheduled)}"

    def after_cancel(self, after_id):
        self.cancelled.append(after_id)


def _text(widget) -> str:
    """Последний текст, который виджету передали в config()."""
    call = widget.config.call_args
    if not call:
        return ""
    return str(call.kwargs.get("text", ""))


def state(**overrides):
    base = {
        "system": "HIP 12345",
        "body": "HIP 12345 A 3",
        "planet_class": "Rocky body",
        "landable": True,
        "atmosphere": "thin sulfur dioxide atmosphere",
        "atmosphere_category": "thin",
        "temperature": 188.0,
        "gravity": 4.2,
        "volcanism": "",
        "mapped": True,
        "bio_signals": 3,
        "predictions": [
            {"genus": "Tussock", "score": 3.0, "percent": 100,
             "notes": ["атмосфера: thin"], "value_cr": 200_000},
            {"genus": "Bacterium", "score": 3.0, "percent": 100,
             "notes": ["атмосфера: thin"], "value_cr": 180_000},
        ],
        "organics": [],
        "system_bodies": [],
        "value_cr": 0,
    }
    base.update(overrides)
    return base


class _OverlayTestCase(unittest.TestCase):
    """База: каждый `tk.Label` — свой мок, иначе все подписи сливаются в один.

    Общая заглушка GUI подменяет в tkinter только Canvas/Toplevel/Frame, а блок
    Exobio рисуется обычными `tk.Label`.
    """

    def setUp(self):
        # Патчим `tk` именно того экземпляра модуля, откуда взят класс:
        # другие тесты делают `sys.modules.pop("overlay")`, и модуль
        # импортируется заново — `sys.modules["overlay"]` может быть уже
        # другой копией, чем `ExobiologyOverlay.__module__`.
        tk_module = ExobiologyOverlay.__init__.__globals__["tk"]
        patcher = mock.patch.object(
            tk_module, "Label",
            side_effect=lambda *args, **kwargs: mock.MagicMock(name="Label"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.master = _Master()
        self.overlay = ExobiologyOverlay(self.master, {})


class ExobioOverlayRenderTests(_OverlayTestCase):

    def test_empty_state_shows_hint(self):
        self.overlay.update_exobiology(None)
        self.assertEqual(_text(self.overlay.body_label), "Тело: —")
        self.assertIn("Отсканируйте тело", _text(self.overlay.params_label))

    def test_body_line_has_system_and_class(self):
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.body_label)
        self.assertIn("HIP 12345 A 3", text)
        self.assertIn("Rocky body", text)

    def test_sample_progress_and_countdown(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "stage": "Sample", "samples": 2,
                       "samples_left": 1, "complete": False, "wait_seconds": 12,
                       "value_cr": 200_000, "seen_before": False}],
            value_cr=200_000,
        ))
        text = _text(self.overlay.organics_label)
        self.assertIn("●●○ 2/3", text)
        self.assertIn("ждите 12 с", text)
        self.assertIn("200 тыс", text)
        # Заголовокsection показывает суммарную оценку.
        self.assertIn("200 тыс", _text(self.overlay.samples_header))

    def test_ready_for_next_sample(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Osseus", "stage": "Sample", "samples": 1,
                       "samples_left": 2, "complete": False, "wait_seconds": 0,
                       "value_cr": 0, "seen_before": False}],
        ))
        text = _text(self.overlay.organics_label)
        self.assertIn("готов к образцу", text)
        self.assertIn("смените точку", text)

    def test_complete_set_is_marked(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "stage": "Sample", "samples": 3,
                       "samples_left": 0, "complete": True, "wait_seconds": 0,
                       "value_cr": 0, "seen_before": False}],
        ))
        self.assertIn("комплект готов", _text(self.overlay.organics_label))

    def test_seen_before_is_flagged(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "stage": "Log", "samples": 0,
                       "samples_left": 3, "complete": False, "wait_seconds": 0,
                       "value_cr": 0, "seen_before": True}],
        ))
        self.assertIn("уже встречалось", _text(self.overlay.organics_label))

    def test_next_action_hint(self):
        self.overlay.update_exobiology(state(organics=[], bio_signals=4))
        self.assertIn("найдите организм", _text(self.overlay.next_action_label))
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "samples": 3, "complete": True,
                       "wait_seconds": 0}],
        ))
        self.assertIn("все комплекты собраны", _text(self.overlay.next_action_label))

    def test_predictions_show_percent_and_reason(self):
        """Таблица: род, процент, оценка и причина — одной строкой на род."""
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.predict_label)
        self.assertIn("род", text)
        self.assertIn("Tussock", text)
        self.assertIn("100%", text)
        self.assertIn("атмосфера: thin", text)
        # Одна строка на род — ради этого режим таблицы и заводили.
        self.assertEqual(len([line for line in text.split("\n") if line.startswith("Tussock")]), 1)
        self.assertNotIn("###", text)

    def test_predictions_table_keeps_list_mode_available(self):
        """Старый «ленточный» режим остаётся: его выбирают настройки блока."""
        self.overlay.settings["exobio_layout"] = "list"
        self.overlay._table_mode = False
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.predict_label)
        self.assertIn("Tussock  100%", text)
        self.assertIn("атмосфера: thin", text)

    def test_predictions_are_capped(self):
        rows = [{"genus": f"Genus{i}", "score": 3.0, "percent": 100,
                 "notes": [], "value_cr": 0} for i in range(9)]
        self.overlay.update_exobiology(state(predictions=rows))
        text = _text(self.overlay.predict_label)
        self.assertIn("Genus0", text)
        self.assertNotIn("Genus5", text)
        self.assertIn("и ещё 4", text)

    def test_system_bodies_are_listed(self):
        self.overlay.update_exobiology(state(system_bodies=[
            {"body": "HIP 12345 A 3", "planet_class": "Rocky body",
             "bio_signals": 3, "mapped": True, "landable": True,
             "has_organics": True},
            {"body": "HIP 12345 B 1", "planet_class": "Icy body",
             "bio_signals": 1, "mapped": False, "landable": False,
             "has_organics": False},
        ]))
        header = _text(self.overlay.bodies_header)
        self.assertIn("2", header)
        text = _text(self.overlay.bodies_label)
        # Имя тела без префикса системы — место в блоке ограничено.
        self.assertIn("A 3", text)
        self.assertNotIn("HIP 12345 A 3", text)
        self.assertIn("образцы", text)
        self.assertIn("карты нет", text)
        self.assertIn("не сесть", text)

    def test_no_biosignals_in_system(self):
        self.overlay.update_exobiology(state(system_bodies=[]))
        self.assertIn("не найдено", _text(self.overlay.bodies_label))

    def test_unknown_body_with_system_bio_summary(self):
        st = {
            "system": "Procyon",
            "body": None,
            "system_bodies": [
                {"body": "Procyon 2", "planet_class": "Rocky body", "bio_signals": 2, "landable": True, "mapped": True}
            ],
            "system_scanned_bodies": 4,
            "system_known_bodies": 10,
        }
        self.overlay.update_exobiology(st)
        body_text = _text(self.overlay.body_label)
        self.assertIn("Procyon", body_text)
        self.assertIn("Тело: —", body_text)
        params = _text(self.overlay.params_label)
        self.assertIn("тел с биосигналами", params)
        self.assertIn("2 сигн.", params)
        self.assertIn("2", _text(self.overlay.bodies_label))

    def test_planet_search_with_scanned_bodies(self):
        st = {
            "system": "Maia",
            "body": None,
            "system_bodies": [],
            "planet_criteria": [{"id": "rocky", "label": "Скалистые"}],
            "planets": [
                {"body": "Maia 3", "planet_class": "Rocky body", "bio_signals": 3, "landable": True}
            ],
        }
        self.overlay.update_exobiology(st)
        planets_text = _text(self.overlay.planets_label)
        self.assertIn("Rocky body", planets_text)
        self.assertIn("сигналов 3", planets_text)
        self.assertIn("тело", planets_text)      # заголовок таблицы


class ExobioOverlayTickerTests(_OverlayTestCase):
    """Отсчёт обязан тикать и без новых данных журнала."""

    def test_tick_scheduled_while_sample_pending(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "samples": 1, "complete": False,
                       "wait_seconds": 20}],
        ))
        self.assertTrue(self.master.scheduled, "таймер не запланирован")
        self.assertEqual(self.master.scheduled[-1][0], 1000)

    def test_no_tick_when_nothing_pending(self):
        self.overlay.update_exobiology(state(organics=[]))
        self.assertEqual(self.master.scheduled, [])

    def test_tick_reschedules_and_destroy_cancels_it(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "samples": 1, "complete": False,
                       "wait_seconds": 20}],
        ))
        first = self.master.scheduled[-1][1]
        first()  # имитируем срабатывание таймера
        self.assertEqual(len(self.master.scheduled), 2, "таймер не перезапущен")
        before = len(self.master.cancelled)
        self.overlay.destroy()
        self.assertEqual(len(self.master.cancelled), before + 1,
                         "destroy() не отменил отложенный тик")
        self.assertIsNone(self.overlay._tick_id)

    def test_previous_tick_is_cancelled_on_update(self):
        pending = state(organics=[{"species": "Tussock", "samples": 1,
                                   "complete": False, "wait_seconds": 20}])
        self.overlay.update_exobiology(pending)
        self.overlay.update_exobiology(pending)
        self.assertTrue(self.master.cancelled, "старый таймер не отменён")

    def test_tick_failure_does_not_raise(self):
        self.overlay.update_exobiology(state(
            organics=[{"species": "Tussock", "samples": 1, "complete": False,
                       "wait_seconds": 20}],
        ))
        callback = self.master.scheduled[-1][1]
        self.overlay._state = None  # рендер упадёт
        self.overlay._render = mock.Mock(side_effect=RuntimeError("boom"))
        callback()  # не должно выбросить исключение


class ExobioFingerprintTests(unittest.TestCase):
    """Хеш данных не должен меняться из-за обратного отсчёта."""

    @staticmethod
    def _fingerprint_of(st):
        module = sys.modules[ExobiologyOverlay.__module__]
        return module.OverlayManager._exobiology_fingerprint(st)

    def test_countdown_does_not_change_fingerprint(self):
        one = self._fingerprint_of(state(organics=[
            {"species": "Tussock", "samples": 1, "stage": "Sample",
             "wait_seconds": 30}]))
        two = self._fingerprint_of(state(organics=[
            {"species": "Tussock", "samples": 1, "stage": "Sample",
             "wait_seconds": 12}]))
        self.assertEqual(one, two)

    def test_new_sample_changes_fingerprint(self):
        one = self._fingerprint_of(state(organics=[
            {"species": "Tussock", "samples": 1, "stage": "Sample"}]))
        two = self._fingerprint_of(state(organics=[
            {"species": "Tussock", "samples": 2, "stage": "Sample"}]))
        self.assertNotEqual(one, two)

    def test_new_body_with_signals_changes_fingerprint(self):
        one = self._fingerprint_of(state(system_bodies=[]))
        two = self._fingerprint_of(state(system_bodies=[
            {"body": "A 3", "bio_signals": 2, "mapped": False}]))
        self.assertNotEqual(one, two)


class ExobioFiltersRenderTests(unittest.TestCase):
    """Фильтр по родам и раздел «Поиск планет» в окне EXOBIO."""

    def setUp(self):
        # В общей GUI-заглушке `tk.Label(...)` возвращает один и тот же
        # MagicMock на все вызовы — не различишь, что написано в конкретной
        # подписи. Здесь каждый Label свой, как в настоящем Tk.
        import overlay

        patcher = mock.patch.object(
            overlay.tk, "Label",
            side_effect=lambda *args, **kwargs: mock.MagicMock(name="Label"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _overlay(self, settings=None):
        from overlay import ExobiologyOverlay

        base = {"font_family": "Consolas", "font_size": 10}
        base.update(settings or {})
        return ExobiologyOverlay(_Master(), base)

    @staticmethod
    def _text(widget):
        call = widget.config.call_args_list[-1]
        if call.kwargs.get("text") is not None:
            return str(call.kwargs["text"])
        return str(call.args[0]) if call.args else ""

    def test_planet_section_lists_found_planets(self):
        overlay = self._overlay({"exobio_show_planet_search": True})
        overlay.update_exobiology({
            "system": "HIP 12345",
            "body": "HIP 12345 A 3",
            "planet_class": "Rocky body",
            "genera_filter": [],
            "planet_criteria": [{"id": "rocky_atmo_land", "label": "Каменистая с атмосферой и посадкой"}],
            "planets": [{
                "body": "HIP 12345 A 3", "planet_class": "Rocky body", "landable": True,
                "atmosphere_category": "thin", "bio_signals": 5, "distance_ls": 812.0,
                "matched": ["Каменистая с атмосферой и посадкой"],
            }],
        })
        self.assertIn("найдено 1", self._text(overlay.planets_header))
        text = self._text(overlay.planets_label)
        self.assertIn("A 3", text)
        self.assertIn("Rocky body", text)
        self.assertIn("атмосфера", text)
        self.assertIn("посадка", text)
        self.assertIn("сигналов 5", text)
        # Причина попадания в список — иначе фильтры непрозрачны.
        self.assertIn("Каменистая с атмосферой и посадкой", text)

    def test_planet_section_says_when_no_criteria(self):
        overlay = self._overlay({"exobio_show_planet_search": True})
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        })
        self.assertIn("критерии не выбраны", self._text(overlay.planets_label))
        self.assertIn("Экзобиология", self._text(overlay.planets_label))

    def test_planet_section_says_when_nothing_found(self):
        overlay = self._overlay({"exobio_show_planet_search": True})
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [{"id": "icy_land", "label": "Ледяная с посадкой"}],
            "planets": [], "system_known_bodies": 5,
        })
        text = self._text(overlay.planets_label)
        self.assertIn("подходящих планет нет", text)
        self.assertIn("журнал знает 5 тел", text)

    def test_planet_section_says_when_system_not_scanned(self):
        """Критерии выбраны, но сканов системы в журнале нет — говорим прямо.

        Раньше блок в этом случае получал пустое состояние и писал «критерии
        не выбраны», хотя галочки на вкладке стояли (жалоба пользователя).
        """
        overlay = self._overlay({"exobio_show_planet_search": True})
        overlay.update_exobiology({
            "system": "HIP 12345",
            "planet_criteria": [{"id": "icy_land", "label": "Ледяная с посадкой"}],
            "planets": [], "system_known_bodies": 0,
        })
        text = self._text(overlay.planets_label)
        self.assertIn("журнал ещё не знает сканов", text)
        self.assertNotIn("критерии не выбраны", text)

    def test_no_body_state_renders_honest_sections(self):
        """Состояние без текущего тела: фильтры и поиск планет всё равно видны."""
        overlay = self._overlay({"exobio_show_planet_search": True})
        overlay.update_exobiology({
            "system": "HIP 12345",
            "planet_criteria": [{"id": "rocky_atmo_land",
                                 "label": "Каменистая с атмосферой и посадкой"}],
            "planets": [{"body": "HIP 12345 A 3", "planet_class": "Rocky body",
                         "landable": True, "atmosphere_category": "thin",
                         "bio_signals": 2, "distance_ls": 812.0,
                         "matched": ["Каменистая с атмосферой и посадкой"]}],
            "system_known_bodies": 4,
        })
        self.assertIn("найдено 1", self._text(overlay.planets_header))
        self.assertIn("A 3", self._text(overlay.planets_label))
        # Параметры тела не врут нулями, когда тело неизвестно.
        self.assertIn("данных о текущем теле нет", self._text(overlay.params_label))

    def test_planet_section_hidden_when_disabled(self):
        overlay = self._overlay({"exobio_show_planet_search": False})
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [{"id": "icy_land", "label": "Ледяная с посадкой"}],
            "planets": [{"body": "HIP 12345 A 1", "planet_class": "Icy body",
                         "landable": True, "atmosphere_category": "none",
                         "bio_signals": 0, "distance_ls": 900.0,
                         "matched": ["Ледяная с посадкой"]}],
        })
        overlay.planets_label.pack_forget.assert_called()

    def test_repeated_ticks_do_not_repack_planet_section(self):
        """Блок тикает раз в секунду — переупаковка на каждом тике мигает."""
        overlay = self._overlay({"exobio_show_planet_search": True})
        state = {
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "genera_filter": [],
            "planet_criteria": [{"id": "rocky_atmo_land",
                                 "label": "Каменистая с атмосферой и посадкой"}],
            "planets": [{
                "body": "HIP 12345 A 3", "planet_class": "Rocky body", "landable": True,
                "atmosphere_category": "thin", "bio_signals": 5, "distance_ls": 812.0,
                "matched": ["Каменистая с атмосферой и посадкой"],
            }],
        }
        overlay.update_exobiology(state)
        for widget in (overlay.planet_separator, overlay.planets_header, overlay.planets_label):
            widget.pack.reset_mock()
            widget.pack_forget.reset_mock()

        for _ in range(5):
            overlay._render()

        for widget in (overlay.planet_separator, overlay.planets_header, overlay.planets_label):
            widget.pack.assert_not_called()
            widget.pack_forget.assert_not_called()

    def test_visibility_switch_repacks_once(self):
        overlay = self._overlay({"exobio_show_planet_search": True})
        state = {
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        }
        overlay.update_exobiology(state)
        overlay.planets_label.pack_forget.reset_mock()

        overlay.settings["exobio_show_planet_search"] = False
        overlay._render()
        overlay.planets_label.pack_forget.assert_called_once()

        # Повторный тик при том же состоянии — уже без переупаковки.
        overlay.planets_label.pack_forget.reset_mock()
        overlay._render()
        overlay.planets_label.pack_forget.assert_not_called()

        overlay.settings["exobio_show_planet_search"] = True
        overlay.planets_label.pack.reset_mock()
        overlay._render()
        overlay.planets_label.pack.assert_called_once()

    def test_planet_section_visible_by_default(self):
        overlay = self._overlay()
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        })
        self.assertTrue(overlay._planets_shown)
        overlay.planets_label.pack.assert_called()

    def test_genus_filter_hides_other_genera(self):
        overlay = self._overlay()
        base = state()
        base["predictions"] = [
            {"genus": "Osseus", "percent": 80, "value_cr": 2_700_000, "notes": []},
            {"genus": "Bacterium", "percent": 40, "value_cr": 300_000, "notes": []},
        ]
        base["genera_filter"] = ["Osseus"]
        overlay.update_exobiology(base)
        text = self._text(overlay.predict_label)
        self.assertIn("Osseus", text)
        self.assertNotIn("Bacterium", text)

    def test_genus_filter_that_excludes_all_says_so(self):
        overlay = self._overlay()
        base = state()
        base["predictions"] = [{"genus": "Osseus", "percent": 80, "value_cr": 1, "notes": []}]
        base["genera_filter"] = ["Electricae"]
        overlay.update_exobiology(base)
        self.assertIn("отфильтрованы", self._text(overlay.predict_label))

    def test_no_filter_shows_all_genera(self):
        overlay = self._overlay()
        base = state()
        base["predictions"] = [
            {"genus": "Osseus", "percent": 80, "value_cr": 1, "notes": []},
            {"genus": "Bacterium", "percent": 40, "value_cr": 1, "notes": []},
        ]
        base["genera_filter"] = []
        overlay.update_exobiology(base)
        text = self._text(overlay.predict_label)
        self.assertIn("Osseus", text)
        self.assertIn("Bacterium", text)

    def test_planet_limit_caps_the_list(self):
        overlay = self._overlay()
        planets = [{
            "body": f"HIP 12345 A {index}", "planet_class": "Icy body", "landable": True,
            "atmosphere_category": "none", "bio_signals": 0, "distance_ls": 100.0 * index,
            "matched": ["Ледяная с посадкой"],
        } for index in range(1, 9)]
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [{"id": "icy_land", "label": "Ледяная с посадкой"}],
            "planets": planets,
        })
        text = self._text(overlay.planets_label)
        self.assertIn("… и ещё 3", text)
        self.assertIn("найдено 8", self._text(overlay.planets_header))


class CarrierRowReuseTests(unittest.TestCase):
    """Строки CARRIER переиспользуются: пересоздание виджетов и было мерцанием."""

    def setUp(self):
        import overlay

        self.created = []

        def factory(*args, **kwargs):
            widget = mock.MagicMock(name="Label")
            widget.text_arg = str(kwargs.get("text", ""))

            def _config(*c_args, **c_kwargs):
                if "text" in c_kwargs:
                    widget.text_arg = str(c_kwargs["text"])

            widget.config.side_effect = _config
            self.created.append(widget)
            return widget

        patcher = mock.patch.object(overlay.tk, "Label", side_effect=factory)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.destroyed = []

        def frame_factory(*args, **kwargs):
            widget = mock.MagicMock(name="Frame")
            widget.destroy.side_effect = lambda: self.destroyed.append(widget)
            return widget

        frame_patcher = mock.patch.object(overlay.tk, "Frame", side_effect=frame_factory)
        frame_patcher.start()
        self.addCleanup(frame_patcher.stop)

    def _overlay(self):
        from overlay import CarrierOverlay

        return CarrierOverlay(_FakeMaster(), {"font_family": "Consolas", "font_size": 10})

    @staticmethod
    def _rows(steel=250, delivered=120):
        return {"commodities": [{
            "key": "steel", "name": "Steel", "amount": steel,
            "delivered": delivered, "need": 4000, "remaining": max(0, 4000 - steel),
        }]}

    def test_rows_are_not_recreated_on_update(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        labels_after_first = len(self.created)
        frames_after_first = len(overlay._row_pool)

        for amount in (300, 350, 400):
            overlay.update_carrier(self._rows(steel=amount))

        self.assertEqual(len(overlay._row_pool), frames_after_first)
        # Новые Label не создавались — только менялся текст существующих.
        self.assertEqual(len(self.created), labels_after_first)
        self.assertEqual(self.destroyed, [])
        cells = overlay._row_pool[0]["cells"]
        self.assertEqual(cells["board"].text_arg, "400 (120)")

    def test_pool_grows_but_never_shrinks_widgets(self):
        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5, "remaining": 4},
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5, "remaining": 3},
        ]})
        self.assertEqual(len(overlay._row_pool), 2)
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5, "remaining": 4},
        ]})
        # Виджет остался в пуле, но скрыт.
        self.assertEqual(len(overlay._row_pool), 2)
        overlay._row_pool[1]["frame"].pack_forget.assert_called()
        self.assertEqual(self.destroyed, [])

    def test_same_order_does_not_repack_rows(self):
        """Пока состав и порядок строк не меняются, геометрию не трогаем."""
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        frame = overlay._row_pool[0]["frame"]
        frame.pack.reset_mock()
        frame.pack_forget.reset_mock()

        for amount in (300, 350, 400):
            overlay.update_carrier(self._rows(steel=amount))

        frame.pack.assert_not_called()
        frame.pack_forget.assert_not_called()
        self.assertEqual(overlay._row_pool[0]["cells"]["board"].text_arg, "400 (120)")

    def test_changed_order_repacks_rows(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5, "remaining": 4},
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5, "remaining": 3},
        ]})
        frame = overlay._row_pool[0]["frame"]
        frame.pack.reset_mock()
        frame.pack_forget.reset_mock()

        # Порядок сменился — строки обязаны переупаковаться.
        overlay.update_carrier({"commodities": [
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5, "remaining": 3},
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5, "remaining": 4},
        ]})
        frame.pack_forget.assert_called()
        self.assertEqual(overlay._row_order, ["gold", "steel"])

    def test_empty_rows_hide_pool_without_touching_it_twice(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        overlay.update_carrier({"commodities": []})
        frame = overlay._row_pool[0]["frame"]
        frame.pack_forget.reset_mock()

        overlay.update_carrier({"commodities": []})
        frame.pack_forget.assert_not_called()
        self.assertEqual(overlay._row_order, [])

    def test_header_uses_the_same_column_spec(self):
        from overlay import CarrierOverlay

        overlay = self._overlay()
        self.assertEqual(len(overlay.COLUMNS), len(overlay.CELL_KEYS))
        self.assertEqual([text for text, _w, _a in CarrierOverlay.COLUMNS],
                         ["Товар", "на борту", "нужно", "ост."])
        # Ширины колонок шапки и строк берутся из одной спецификации.
        widths = [width for _t, width, _a in CarrierOverlay.COLUMNS]
        self.assertEqual(widths, [18, 9, 7, 6])

    def test_canvas_resize_sets_inner_width(self):
        overlay = self._overlay()
        overlay._on_canvas_resize(mock.Mock(width=286))
        overlay.canvas.itemconfigure.assert_called_with(overlay._inner_window, width=286)

    def test_canvas_resize_ignores_garbage(self):
        overlay = self._overlay()
        overlay._on_canvas_resize(mock.Mock(width=0))
        overlay._on_canvas_resize(mock.Mock(width=None))
        overlay.canvas.itemconfigure.assert_not_called()


class ExobioSectionOrderTests(unittest.TestCase):
    """Раздел «Поиск планет» обязан быть выше списка тел системы.

    Окно EXOBIO не резиновое: при переполнении обрезается низ, поэтому раздел,
    ради которого пользователь и включал поиск, не должен стоять последним.
    """

    def setUp(self):
        import overlay

        self.made = []

        def factory(*args, **kwargs):
            widget = mock.MagicMock(name="Label")
            widget.text_arg = str(kwargs.get("text", ""))
            self.made.append(widget)
            return widget

        patcher = mock.patch.object(overlay.tk, "Label", side_effect=factory)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _overlay(self):
        from overlay import ExobiologyOverlay

        return ExobiologyOverlay(_Master(), {"font_family": "Consolas", "font_size": 10})

    def test_planet_section_is_packed_before_bodies(self):
        overlay = self._overlay()
        texts = [w.text_arg for w in self.made]
        planets_at = texts.index("Поиск планет:")
        bodies_at = texts.index("Тела системы:")
        self.assertLess(planets_at, bodies_at,
                        f"порядок разделов: {texts}")

    def test_default_height_fits_content(self):
        """Высота по умолчанию обязана вмещать разделы до списка тел."""
        import overlay

        self.assertGreaterEqual(overlay.DEFAULT_SETTINGS["exobio_height"], 600)

    def test_reshow_keeps_position(self):
        """После «скрыть/показать» раздел не должен уезжать в конец окна."""
        overlay = self._overlay()
        overlay.update_exobiology({
            "system": "S", "body": "S A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        })
        overlay.settings["exobio_show_planet_search"] = False
        overlay._render()
        overlay.settings["exobio_show_planet_search"] = True
        overlay.planets_header.pack.reset_mock()
        overlay._render()

        kwargs = overlay.planets_header.pack.call_args.kwargs
        self.assertIs(kwargs.get("before"), overlay.bodies_separator,
                      "pack() без before= дописал бы раздел в конец окна")

    def test_bodies_separator_exists(self):
        overlay = self._overlay()
        self.assertIsNotNone(getattr(overlay, "bodies_separator", None))


class CarrierColumnGeometryTests(unittest.TestCase):
    """Шапка и строки CARRIER обязаны получать одинаковую геометрию.

    Проверяем не константу `COLUMNS`, а то, что реально передаётся в виджеты:
    именно расхождение шрифта или ширины и разъезжает колонки на экране.
    """

    def setUp(self):
        import overlay

        self.calls = []

        def factory(*args, **kwargs):
            self.calls.append(dict(kwargs))
            return mock.MagicMock(name="Label")

        patcher = mock.patch.object(overlay.tk, "Label", side_effect=factory)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _overlay(self):
        # Шрифт намеренно пропорциональный: на Consolas расхождение жирного и
        # обычного начертания невидно, а на Segoe UI колонки разъезжаются.
        from overlay import CarrierOverlay

        return CarrierOverlay(_FakeMaster(), {"font_family": "Segoe UI", "font_size": 10})

    def _geometry(self, overlay):
        """(заголовки, ячейки первой строки) — списки (font, width, anchor)."""
        from overlay import CarrierOverlay

        titles = {text for text, _w, _a in CarrierOverlay.COLUMNS}
        header = [call for call in self.calls if call.get("text") in titles]
        # Ячейки строки создаются пустыми, после заголовков.
        rows = [call for call in self.calls
                if call.get("text") == "" and "width" in call and "anchor" in call]
        cells = rows[:len(CarrierOverlay.COLUMNS)]
        return header, cells

    def test_header_and_rows_share_width_and_anchor(self):
        from overlay import CarrierOverlay

        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0,
             "need": 5, "remaining": 4},
        ]})
        header, cells = self._geometry(overlay)

        self.assertEqual(len(header), len(CarrierOverlay.COLUMNS), header)
        self.assertEqual(len(cells), len(CarrierOverlay.COLUMNS), cells)
        for index, (_text, width, anchor) in enumerate(CarrierOverlay.COLUMNS):
            self.assertEqual(header[index]["width"], width)
            self.assertEqual(cells[index]["width"], width)
            self.assertEqual(header[index]["anchor"], anchor)
            self.assertEqual(cells[index]["anchor"], anchor)

    def test_header_font_matches_cell_font(self):
        """Жирный заголовок над жирной ячейкой: иначе width даст разную ширину."""
        from overlay import CarrierOverlay

        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0,
             "need": 5, "remaining": 4},
        ]})
        header, cells = self._geometry(overlay)

        for index in range(len(CarrierOverlay.COLUMNS)):
            self.assertEqual(tuple(header[index]["font"]), tuple(cells[index]["font"]),
                             f"колонка {index}: шрифт шапки != шрифт ячейки")
            expect_bold = index in CarrierOverlay.BOLD_COLUMNS
            self.assertEqual(len(header[index]["font"]) == 3, expect_bold,
                             f"колонка {index}: жирность не совпала с BOLD_COLUMNS")

    def test_all_columns_use_one_font_family(self):
        from overlay import CarrierOverlay

        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0,
             "need": 5, "remaining": 4},
        ]})
        header, cells = self._geometry(overlay)
        families = {call["font"][0] for call in header + cells}
        self.assertEqual(families, {"Segoe UI"})
        sizes = {call["font"][1] for call in header + cells}
        self.assertEqual(sizes, {9}, "шапка и строки обязаны быть одного кегля")


class CargoRowReuseTests(unittest.TestCase):
    """Строки трюма (CARGO) переиспользуются: пересоздание и было миганием."""

    def setUp(self):
        import overlay

        self.created = []

        def label_factory(*args, **kwargs):
            widget = mock.MagicMock(name="Label")
            widget.text_arg = str(kwargs.get("text", ""))

            def _config(*c_args, **c_kwargs):
                if "text" in c_kwargs:
                    widget.text_arg = str(c_kwargs["text"])

            widget.config.side_effect = _config
            self.created.append(widget)
            return widget

        patcher = mock.patch.object(overlay.tk, "Label", side_effect=label_factory)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.destroyed = []

        def frame_factory(*args, **kwargs):
            widget = mock.MagicMock(name="Frame")
            widget.destroy.side_effect = lambda: self.destroyed.append(widget)
            return widget

        frame_patcher = mock.patch.object(overlay.tk, "Frame", side_effect=frame_factory)
        frame_patcher.start()
        self.addCleanup(frame_patcher.stop)

    def _overlay(self):
        from overlay import CargoOverlay

        return CargoOverlay(_FakeMaster(), {"font_family": "Consolas", "font_size": 10})

    @staticmethod
    def _data(*rows):
        return {"cargo_count": sum(r["Count"] for r in rows), "cargo_capacity": 100,
                "inventory": list(rows)}

    def test_rows_are_not_recreated_on_update(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Name_Localised": "Steel", "Count": 10}))
        labels_after_first = len(self.created)

        for count in (20, 30, 40):
            overlay.update_cargo(self._data(
                {"Name": "steel", "Name_Localised": "Steel", "Count": count}))

        self.assertEqual(len(self.created), labels_after_first)
        self.assertEqual(self.destroyed, [])
        self.assertEqual(overlay._cargo_pool[0]["count"].text_arg, "  40")
        self.assertEqual(overlay._cargo_pool[0]["name"].text_arg, "Steel")

    def test_same_inventory_does_not_repack(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10}))
        frame = overlay._cargo_pool[0]["frame"]
        frame.pack.reset_mock()
        frame.pack_forget.reset_mock()

        overlay.update_cargo(self._data({"Name": "steel", "Count": 25}))
        frame.pack.assert_not_called()
        frame.pack_forget.assert_not_called()

    def test_changed_inventory_repacks(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10}))
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10},
                                        {"Name": "gold", "Count": 5}))
        self.assertEqual(len(overlay._cargo_pool), 2)
        self.assertEqual(overlay._cargo_order, ["steel", "gold"])

    def test_stolen_goods_are_marked(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data(
            {"Name": "tritium", "Name_Localised": "Tritium", "Count": 8, "Stolen": 3}))
        entry = overlay._cargo_pool[0]
        self.assertEqual(entry["icon"].text_arg, "!")
        self.assertIn("(3 stl)", entry["count"].text_arg)

    def test_empty_hold_shows_placeholder(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10}))
        overlay.update_cargo({"cargo_count": 0, "cargo_capacity": 100, "inventory": []})
        self.assertEqual(overlay._cargo_order, [])
        overlay._cargo_pool[0]["frame"].pack_forget.assert_called()
        self.assertEqual(self.destroyed, [])


class ExobioVisualDesignTests(_OverlayTestCase):
    """Тесты визуальных элементов дизайна и компактного режима оверлея EXOBIO."""

    def test_format_prob_bar(self):
        self.assertEqual(self.overlay._format_prob_bar(100, length=8), "■■■■■■■■")
        self.assertEqual(self.overlay._format_prob_bar(50, length=8), "■■■■□□□□")
        self.assertEqual(self.overlay._format_prob_bar(0, length=8), "□□□□□□□□")
        self.assertEqual(self.overlay._format_prob_bar(None), "")

    def test_telemetry_chips_display_status(self):
        self.overlay.update_exobiology(state(
            bio_signals=3, landable=True, mapped=True, gravity=4.2, temperature=188.0
        ))
        self.assertIn("3 BIO", _text(self.overlay.chip_bio))
        self.assertIn("ПОСАДКА", _text(self.overlay.chip_land))
        self.assertIn("DSS ✓", _text(self.overlay.chip_dss))
        self.assertIn("0.42g", _text(self.overlay.chip_grav))
        self.assertIn("188K", _text(self.overlay.chip_temp))

    def test_telemetry_chips_unlandable_and_unmapped(self):
        self.overlay.update_exobiology(state(
            bio_signals=0, landable=False, mapped=False
        ))
        self.assertIn("0 BIO", _text(self.overlay.chip_bio))
        self.assertIn("НЕ СЕСТЬ", _text(self.overlay.chip_land))
        self.assertIn("DSS ✗", _text(self.overlay.chip_dss))

    def test_predictions_include_led_pips_bar(self):
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.predict_label)
        self.assertIn("■■■■■■■■", text)

    def test_compact_mode_toggle_switches_setting_and_renders(self):
        self.overlay.update_exobiology(state())
        self.assertTrue(self.overlay.settings.get("exobio_compact", True))

        self.overlay._toggle_compact_mode()
        self.assertFalse(self.overlay.settings["exobio_compact"])
        legacy_params = _text(self.overlay.params_label)
        self.assertIn("T 188 K", legacy_params)
        self.assertIn("посадка возможна", legacy_params)

        self.overlay._toggle_compact_mode()
        self.assertTrue(self.overlay.settings["exobio_compact"])
        compact_params = _text(self.overlay.params_label)
        self.assertIn("thin sulfur dioxide atmosphere", compact_params)


class ExobioOverlayFootfallAndLandableTests(_OverlayTestCase):
    """Тесты отображения бонуса первопроходца (5х) и отключения прогноза без посадки."""

    def test_unlandable_planet_disables_prediction_display(self):
        self.overlay.update_exobiology(state(landable=False, predictions=[]))
        text = _text(self.overlay.predict_label)
        self.assertIn("посадка невозможна", text)
        self.assertIn("био-прогноз отключен", text)
        self.assertIn("НЕ СЕСТЬ", _text(self.overlay.chip_land))

    def test_no_first_footfall_displays_5x_bonus_in_ui(self):
        self.overlay.update_exobiology(state(
            no_first_footfall=True,
            predictions=[
                {"genus": "Stratum", "percent": 100, "value_cr": 95_054_000, "notes": []}
            ],
            organics=[
                {"species": "Stratum Tectonicas", "samples": 3, "complete": True,
                 "value_cr": 95_054_000, "stage": "Sample"}
            ],
            value_cr=95_054_000,
        ))
        # Проверяем чип первопроходца в бейджах
        self.assertIn("БОНУС ×5", _text(self.overlay.chip_footfall))

        # Проверяем заголовки и таблицы
        samples_hdr = _text(self.overlay.samples_header)
        self.assertIn("бонус ×5", samples_hdr)
        self.assertIn("95.1 млн", samples_hdr)

        predict_hdr = _text(self.overlay.predict_header)
        self.assertIn("бонус ×5", predict_hdr)

        predict_txt = _text(self.overlay.predict_label)
        self.assertIn("≈кр (×5)", predict_txt)
        self.assertIn("95.1 млн", predict_txt)

    def test_known_footfall_by_other_pilot_shows_standard_mode(self):
        self.overlay.update_exobiology(state(
            no_first_footfall=False,
            first_footfall_by="Cmdr OtherPilot",
            predictions=[
                {"genus": "Stratum", "percent": 100, "value_cr": 19_010_800, "notes": []}
            ],
            value_cr=19_010_800,
        ))
        self.assertIn("ЕСТЬ", _text(self.overlay.chip_footfall))
        self.assertNotIn("БОНУС ×5", _text(self.overlay.chip_footfall))
        self.assertNotIn("бонус ×5", _text(self.overlay.samples_header))
        self.assertNotIn("бонус ×5", _text(self.overlay.predict_header))


if __name__ == "__main__":
    unittest.main()
