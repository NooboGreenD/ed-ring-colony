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
        self.overlay.update_exobiology(state())
        text = _text(self.overlay.predict_label)
        self.assertIn("Tussock  100%", text)
        self.assertIn("атмосфера: thin", text)
        self.assertNotIn("###", text)

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


if __name__ == "__main__":
    unittest.main()
