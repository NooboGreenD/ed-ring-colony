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

from PySide6.QtCore import Qt  # noqa: E402

from overlay import ExobiologyOverlay  # noqa: E402


def _text(widget) -> str:
    """Текст подписи: у Qt он хранится в самом виджете."""
    return str(widget.text())


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
    """База: настоящее окно EXOBIO на Qt, без подмены виджетов."""

    def setUp(self):
        self.overlay = ExobiologyOverlay(None, {})
        self.addCleanup(self.overlay.destroy)


class ExobioOverlayRenderTests(_OverlayTestCase):

    def wide_overlay(self):
        """Блок шириной 640 px: таблица родов в него влезает целиком."""
        overlay = ExobiologyOverlay(None, {"font_family": "Consolas", "font_size": 10,
                                           "exobio_width": 640})
        self.addCleanup(overlay.destroy)
        return overlay

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
        overlay = self.wide_overlay()
        overlay.update_exobiology(state())
        text = _text(overlay.predict_label)
        self.assertIn("род", text)
        self.assertIn("Tussock", text)
        self.assertIn("100%", text)
        self.assertIn("атмосфера: thin", text)
        # Одна строка на род — ради этого режим таблицы и заводили.
        self.assertEqual(len([line for line in text.split("\n") if line.startswith("Tussock")]), 1)
        self.assertNotIn("###", text)

    def test_narrow_block_prints_predictions_without_a_table(self):
        """В узкий блок таблица не влезает — печатаем строки с переносом.

        Иначе Qt обрезал бы последний столбец, а там как раз причина.
        """
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.predict_label)
        self.assertIn("Tussock", text)
        self.assertIn("атмосфера: thin", text)
        self.assertNotIn("род ", text, "таблица в узком блоке не печатается")

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

    PENDING = {"species": "Tussock", "samples": 1, "complete": False,
               "wait_seconds": 20}

    def test_tick_scheduled_while_sample_pending(self):
        self.overlay.update_exobiology(state(organics=[dict(self.PENDING)]))
        self.assertIsNotNone(self.overlay._tick, "таймер не запланирован")
        self.assertTrue(self.overlay._tick.isActive(), "таймер не запущен")
        self.assertEqual(self.overlay._tick.interval(), 1000)

    def test_no_tick_when_nothing_pending(self):
        self.overlay.update_exobiology(state(organics=[]))
        self.assertIsNone(self.overlay._tick)

    def test_tick_reschedules_and_destroy_cancels_it(self):
        self.overlay.update_exobiology(state(organics=[dict(self.PENDING)]))
        first = self.overlay._tick
        self.overlay._on_tick()  # имитируем срабатывание таймера
        self.assertIsNot(first, self.overlay._tick, "таймер не перезапущен")
        self.assertTrue(self.overlay._tick.isActive())
        self.overlay.destroy()
        self.assertIsNone(self.overlay._tick, "destroy() не отменил тик")
        self.assertIsNone(self.overlay._tick_id)

    def test_previous_tick_is_cancelled_on_update(self):
        pending = state(organics=[dict(self.PENDING)])
        self.overlay.update_exobiology(pending)
        first = self.overlay._tick
        self.overlay.update_exobiology(pending)
        self.assertFalse(first.isActive(), "старый таймер не отменён")

    def test_tick_failure_does_not_raise(self):
        self.overlay.update_exobiology(state(organics=[dict(self.PENDING)]))
        self.overlay._render = mock.Mock(side_effect=RuntimeError("boom"))
        self.overlay._on_tick()  # не должно выбросить исключение


class ExobioFingerprintTests(unittest.TestCase):
    """Хеш данных не должен меняться из-за обратного отсчёта."""

    @staticmethod
    def _fingerprint_of(st):
        # Окна блоков живут в `overlay_blocks`, менеджер — в `overlay`.
        from overlay import OverlayManager

        return OverlayManager._exobiology_fingerprint(st)

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

    def _overlay(self, settings=None):
        from overlay import ExobiologyOverlay

        base = {"font_family": "Consolas", "font_size": 10}
        base.update(settings or {})
        overlay = ExobiologyOverlay(None, base)
        self.addCleanup(overlay.destroy)
        return overlay

    @staticmethod
    def _text(widget):
        return str(widget.text())

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
        self.assertTrue(overlay.planets_label.isHidden(),
                        "выключенный раздел обязан быть скрыт")

    def test_repeated_ticks_do_not_touch_planet_section(self):
        """Блок тикает раз в секунду — правка видимости на каждом тике мигает."""
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
        watched = (overlay.planet_separator, overlay.planets_header, overlay.planets_label)
        originals = [widget.setVisible for widget in watched]
        spies = []
        for widget in watched:
            spy = mock.Mock(wraps=widget.setVisible)
            widget.setVisible = spy
            spies.append(spy)
        for widget, original in zip(watched, originals):
            self.addCleanup(setattr, widget, "setVisible", original)

        for _ in range(5):
            overlay._render()

        for spy in spies:
            spy.assert_not_called()

    def test_visibility_switch_happens_once(self):
        overlay = self._overlay({"exobio_show_planet_search": True})
        state = {
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        }
        overlay.update_exobiology(state)
        self.assertFalse(overlay.planets_label.isHidden())

        with mock.patch.object(overlay.planets_label, "setVisible",
                               wraps=overlay.planets_label.setVisible) as set_visible:
            overlay.settings["exobio_show_planet_search"] = False
            overlay._render()
            set_visible.assert_called_once_with(False)
            self.assertTrue(overlay.planets_label.isHidden())

            # Повторный тик при том же состоянии — уже без правки видимости.
            set_visible.reset_mock()
            overlay._render()
            set_visible.assert_not_called()

            overlay.settings["exobio_show_planet_search"] = True
            overlay._render()
            set_visible.assert_called_once_with(True)
        self.assertFalse(overlay.planets_label.isHidden())

    def test_planet_section_visible_by_default(self):
        overlay = self._overlay()
        overlay.update_exobiology({
            "system": "HIP 12345", "body": "HIP 12345 A 3", "planet_class": "Rocky body",
            "planet_criteria": [], "planets": [],
        })
        self.assertTrue(overlay._planets_shown)
        self.assertFalse(overlay.planets_label.isHidden())

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

    def _overlay(self):
        from overlay import CarrierOverlay

        overlay = CarrierOverlay(None, {"font_family": "Consolas", "font_size": 10})
        self.addCleanup(overlay.destroy)
        return overlay

    @staticmethod
    def _rows(steel=250, delivered=120):
        return {"commodities": [{
            "key": "steel", "name": "Steel", "amount": steel,
            "delivered": delivered, "need": 4000, "remaining": max(0, 4000 - steel),
        }]}

    def test_filters_change_rows_but_not_totals_and_can_be_cleared(self):
        overlay = self._overlay()
        data = {"commodities": [
            {"key": "steel", "name": "Steel", "amount": 20, "need": 100, "remaining": 80},
            {"key": "gold", "name": "Gold", "amount": 50, "need": 10, "remaining": 0},
        ], "need_total": 110, "need_label": "Build", "need_source": "project"}
        overlay.update_carrier(data)
        original = overlay.summary_label.text()
        overlay.settings.update(carrier_filter="missing", carrier_search="steel")
        overlay.update_carrier(data)
        self.assertEqual(overlay._row_pool[0]["cells"]["name"].text(), "Steel")
        self.assertIn("Показано 1 / 2", overlay.summary_label.text())
        self.assertTrue(overlay.summary_label.text().endswith(original))
        overlay.settings.update(carrier_filter="all", carrier_search="")
        overlay.update_carrier(data)
        self.assertEqual(overlay.summary_label.text(), original)
        self.assertEqual(overlay._row_pool[1]["cells"]["name"].text(), "Gold")

    def test_rows_are_not_recreated_on_update(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        row = overlay._row_pool[0]["frame"]
        cells = dict(overlay._row_pool[0]["cells"])

        for amount in (300, 350, 400):
            overlay.update_carrier(self._rows(steel=amount))

        self.assertEqual(len(overlay._row_pool), 1)
        # Те же самые виджеты — менялся только текст.
        self.assertIs(overlay._row_pool[0]["frame"], row)
        for key, cell in cells.items():
            self.assertIs(overlay._row_pool[0]["cells"][key], cell)
        self.assertEqual(cells["board"].text(), "400 (120)")

    def test_pool_grows_but_never_shrinks_widgets(self):
        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5,
             "remaining": 4},
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5,
             "remaining": 3},
        ]})
        self.assertEqual(len(overlay._row_pool), 2)
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5,
             "remaining": 4},
        ]})
        # Виджет остался в пуле, но скрыт.
        self.assertEqual(len(overlay._row_pool), 2)
        self.assertTrue(overlay._row_pool[1]["frame"].isHidden())

    def test_same_order_does_not_touch_rows(self):
        """Пока состав и порядок строк не меняются, видимость не трогаем."""
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        frame = overlay._row_pool[0]["frame"]
        with mock.patch.object(frame, "setVisible", wraps=frame.setVisible) as set_visible:
            for amount in (300, 350, 400):
                overlay.update_carrier(self._rows(steel=amount))
            set_visible.assert_not_called()
        self.assertEqual(overlay._row_pool[0]["cells"]["board"].text(), "400 (120)")

    def test_changed_order_updates_rows(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5,
             "remaining": 4},
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5,
             "remaining": 3},
        ]})
        # Порядок сменился — строки обязаны перестроиться.
        overlay.update_carrier({"commodities": [
            {"key": "gold", "name": "Gold", "amount": 2, "delivered": 0, "need": 5,
             "remaining": 3},
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0, "need": 5,
             "remaining": 4},
        ]})
        self.assertEqual(overlay._row_order, ["gold", "steel"])
        self.assertEqual(overlay._row_pool[0]["cells"]["name"].text(), "Gold")

    def test_empty_rows_hide_pool_without_touching_it_twice(self):
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        overlay.update_carrier({"commodities": []})
        frame = overlay._row_pool[0]["frame"]
        with mock.patch.object(frame, "setVisible", wraps=frame.setVisible) as set_visible:
            overlay.update_carrier({"commodities": []})
            set_visible.assert_not_called()
        self.assertEqual(overlay._row_order, [])
        self.assertFalse(overlay._empty_label.isHidden())

    def test_header_uses_the_same_column_spec(self):
        from overlay import CarrierOverlay

        overlay = self._overlay()
        self.assertEqual(len(overlay.COLUMNS), len(overlay.CELL_KEYS))
        self.assertEqual([text for text, _w, _a in CarrierOverlay.COLUMNS],
                         ["Товар", "на борту", "нужно", "ост."])
        # Ширины колонок шапки и строк берутся из одной спецификации.
        widths = [width for _t, width, _a in CarrierOverlay.COLUMNS]
        self.assertEqual(widths, [0, 11, 7, 6])

    def test_columns_are_measured_with_the_block_font(self):
        """Ширина колонки считается по шрифту блока, а не «на глаз»."""
        overlay = self._overlay()
        overlay.update_carrier(self._rows())
        header, cells = overlay._header_cells, overlay._row_pool[0]["cells"]
        for index, key in enumerate(overlay.CELL_KEYS):
            expected = overlay._cell_width(overlay.COLUMNS[index][1])
            self.assertEqual(cells[key].minimumWidth(), expected if expected else 0)
            if index == 0:
                self.assertEqual(expected, 0, "колонка названия тянется по ширине")
            else:
                self.assertEqual(header[index][0].width(), expected)


class ExobioSectionOrderTests(unittest.TestCase):
    """Раздел «Поиск планет» обязан быть выше списка тел системы.

    Окно EXOBIO не резиновое: при переполнении обрезается низ, поэтому раздел,
    ради которого пользователь и включал поиск, не должен стоять последним.
    """

    def _overlay(self):
        from overlay import ExobiologyOverlay

        overlay = ExobiologyOverlay(None, {"font_family": "Consolas", "font_size": 10})
        self.addCleanup(overlay.destroy)
        return overlay

    def test_planet_section_is_placed_before_bodies(self):
        overlay = self._overlay()

        def index(widget):
            return overlay.body.indexOf(widget)

        self.assertLess(index(overlay.planets_header), index(overlay.bodies_header),
                        "«Поиск планет» обязан стоять выше списка тел")

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
        position = overlay.body.indexOf(overlay.planets_header)
        overlay.settings["exobio_show_planet_search"] = False
        overlay._render()
        overlay.settings["exobio_show_planet_search"] = True
        overlay._render()

        self.assertEqual(overlay.body.indexOf(overlay.planets_header), position,
                         "раздел уехал в другое место раскладки")
        self.assertFalse(overlay.planets_header.isHidden())

    def test_bodies_separator_exists(self):
        overlay = self._overlay()
        self.assertIsNotNone(getattr(overlay, "bodies_separator", None))


class CarrierColumnGeometryTests(unittest.TestCase):
    """Шапка и строки CARRIER обязаны получать одинаковую геометрию.

    Проверяем не константу `COLUMNS`, а то, что реально стоит на виджетах:
    именно расхождение шрифта или ширины и разъезжает колонки на экране.
    """

    def _overlay(self):
        # Шрифт намеренно пропорциональный: на Consolas расхождение жирного и
        # обычного начертания невидно, а на Segoe UI колонки разъезжаются.
        from overlay import CarrierOverlay

        overlay = CarrierOverlay(None, {"font_family": "Segoe UI", "font_size": 10})
        self.addCleanup(overlay.destroy)
        return overlay

    def _with_row(self):
        overlay = self._overlay()
        overlay.update_carrier({"commodities": [
            {"key": "steel", "name": "Steel", "amount": 1, "delivered": 0,
             "need": 5, "remaining": 4},
        ]})
        return overlay, overlay._header_cells, overlay._row_pool[0]["cells"]

    def test_header_and_rows_share_width_and_anchor(self):
        from overlay import CarrierOverlay

        overlay, header, cells = self._with_row()
        self.assertEqual(len(header), len(CarrierOverlay.COLUMNS), header)
        for index, (_text, chars, align) in enumerate(CarrierOverlay.COLUMNS):
            key = CarrierOverlay.CELL_KEYS[index]
            expected = overlay._cell_width(chars)
            self.assertEqual(cells[key].minimumWidth(), expected)
            if expected:
                self.assertEqual(header[index][0].width(), expected)
            right = cells[key].alignment() & Qt.AlignRight
            self.assertEqual(bool(right), align == "right",
                             f"колонка {index}: выравнивание не совпало")

    def test_header_font_matches_cell_font(self):
        """Жирный заголовок над жирной ячейкой: иначе ширины разъезжаются."""
        from overlay import CarrierOverlay

        _overlay, header, cells = self._with_row()
        for index in range(len(CarrierOverlay.COLUMNS)):
            key = CarrierOverlay.CELL_KEYS[index]
            header_font, cell_font = header[index][0].font(), cells[key].font()
            self.assertEqual(header_font.pixelSize(), cell_font.pixelSize(),
                             f"колонка {index}: кегль шапки != кегль ячейки")
            expect_bold = index in CarrierOverlay.BOLD_COLUMNS
            self.assertEqual(cell_font.bold(), expect_bold,
                             f"колонка {index}: жирность не совпала с BOLD_COLUMNS")

    def test_all_columns_use_one_font_family(self):
        _overlay, header, cells = self._with_row()
        families = {widget.font().family() for widget, _chars in header}
        families |= {cell.font().family() for cell in cells.values()}
        self.assertEqual(families, {"Segoe UI"})
        sizes = {cell.font().pixelSize() for cell in cells.values()}
        self.assertEqual(len(sizes), 1, "ячейки обязаны быть одного кегля")


class CargoRowReuseTests(unittest.TestCase):
    """Строки трюма (CARGO) переиспользуются: пересоздание и было миганием."""

    def _overlay(self):
        from overlay import CargoOverlay

        overlay = CargoOverlay(None, {"font_family": "Consolas", "font_size": 10})
        self.addCleanup(overlay.destroy)
        return overlay

    @staticmethod
    def _data(*rows):
        return {"cargo_count": sum(row["Count"] for row in rows), "cargo_capacity": 100,
                "inventory": list(rows)}

    def test_rows_are_not_recreated_on_update(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Name_Localised": "Steel",
                                         "Count": 10}))
        entry = dict(overlay._cargo_pool[0])

        for count in (20, 30, 40):
            overlay.update_cargo(self._data(
                {"Name": "steel", "Name_Localised": "Steel", "Count": count}))

        self.assertEqual(len(overlay._cargo_pool), 1)
        for key, widget in entry.items():
            self.assertIs(overlay._cargo_pool[0][key], widget)
        self.assertEqual(overlay._cargo_pool[0]["count"].text(), "  40")
        self.assertEqual(overlay._cargo_pool[0]["name"].text(), "Steel")

    def test_same_inventory_does_not_touch_rows(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10}))
        frame = overlay._cargo_pool[0]["frame"]
        with mock.patch.object(frame, "setVisible", wraps=frame.setVisible) as set_visible:
            overlay.update_cargo(self._data({"Name": "steel", "Count": 25}))
            set_visible.assert_not_called()

    def test_changed_inventory_builds_new_rows(self):
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
        self.assertEqual(entry["icon"].text(), "!")
        self.assertIn("(3 stl)", entry["count"].text())

    def test_empty_hold_shows_placeholder(self):
        overlay = self._overlay()
        overlay.update_cargo(self._data({"Name": "steel", "Count": 10}))
        overlay.update_cargo({"cargo_count": 0, "cargo_capacity": 100, "inventory": []})
        self.assertEqual(overlay._cargo_order, [])
        self.assertTrue(overlay._cargo_pool[0]["frame"].isHidden())
        self.assertFalse(overlay.empty_label.isHidden())


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
        self.assertIn("бонус ×5", predict_txt)
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
