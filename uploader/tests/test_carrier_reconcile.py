"""Сверка груза авианосца с достоверным тоннажем (блок CARRIER).

Жалоба пилота: «в оверлее CARRIER иногда остаются старые записи грузов с
авианосца». Так и было — поимённый список жил своей жизнью:

* при запуске разбирается хвост старых журналов, и переводы трёхдневной
  давности выглядели как груз «на борту прямо сейчас»;
* груз увозят другие командиры и покупают с рынка FC — в журнале владельца
  таких событий нет, позиция висела вечно;
* пустой ответ Raven Colonial просто отбрасывался, и «разгруженный носитель»
  продолжал показывать прежний список;
* фоновый ответ Raven применялся к активному носителю, а не к тому, по
  которому его запрашивали: перестыковались — получили чужие тонны;
* файлы журнала проигрывались от новых к старым, поэтому вчерашние события
  перетирали сегодняшние.

Здесь проверяется лечение: `CarrierState.reconcile()` сводит список с
`CarrierStats.SpaceUsage.Cargo`, тоннаж двигается нашими дельтами, снимок
Raven адресный, а восстановление из журнала — хронологическое.
"""

import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from carrier import CarrierState, CarrierTracker, event_time  # noqa: E402

OWN_ID = 3700005632
OTHER_ID = 3700009999


def iso(offset_seconds: float = 0.0) -> str:
    """Отметка времени журнала: UTC, ISO-8601, как пишет игра."""
    moment = datetime.fromtimestamp(time.time() + offset_seconds, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def stats_event(cargo: int, free: int = 17379, when: float = -1.0,
                carrier_id: int = OWN_ID) -> dict:
    return {
        "timestamp": iso(when),
        "event": "CarrierStats",
        "CarrierID": carrier_id,
        "Name": "Spirula",
        "Callsign": "L14-X1J",
        "SpaceUsage": {
            "TotalCapacity": 25000, "Crew": 5450, "Cargo": cargo,
            "CargoSpaceReserved": 44, "FreeSpace": free,
        },
    }


def transfer_event(when: float = -1.0, market_id: int = OWN_ID, **cargo) -> dict:
    return {
        "timestamp": iso(when),
        "event": "CargoTransfer",
        "MarketID": market_id,
        "Transfers": [
            {"Type": name, "Count": abs(int(count)),
             "Direction": "tocarrier" if int(count) > 0 else "toship"}
            for name, count in cargo.items()
        ],
    }


def dock_event(market_id: int = OWN_ID, when: float = -1.0, name: str = "FC Spirula") -> dict:
    return {
        "timestamp": iso(when), "event": "Docked", "StationType": "FleetCarrier",
        "StationName": name, "MarketID": market_id, "StarSystem": "Hermitage",
    }


class EventTimeTests(unittest.TestCase):
    """Возраст события нужен, чтобы старый CarrierStats не резал свежий груз."""

    def test_journal_timestamp_is_parsed_as_utc(self):
        moment = event_time({"timestamp": "2020-03-27T09:42:04Z"})
        self.assertEqual(
            datetime.fromtimestamp(moment, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "2020-03-27T09:42:04Z")

    def test_missing_or_broken_timestamp_means_now(self):
        now = time.time()
        for event in ({}, {"timestamp": ""}, {"timestamp": "вчера"}, {"timestamp": 123}):
            self.assertAlmostEqual(event_time(event), now, delta=5)

    def test_future_timestamp_is_clamped_to_now(self):
        self.assertLessEqual(event_time({"timestamp": iso(3600)}), time.time() + 1)


class ReconcileTests(unittest.TestCase):
    """Поимённый список против достоверного тоннажа."""

    def setUp(self):
        self.tracker = CarrierTracker()

    def test_empty_hold_clears_ghost_rows(self):
        """Главный случай: CarrierStats говорит «0 t», список обязан исчезнуть."""
        self.tracker.handle(dock_event(when=-3 * 86400))
        self.tracker.handle(transfer_event(when=-3 * 86400, steel=2000))
        self.assertEqual(self.tracker.state.tracked_total, 2000)

        self.assertTrue(self.tracker.handle(stats_event(cargo=0, when=-5)))
        state = self.tracker.state
        self.assertEqual(state.commodities, {})
        self.assertEqual(state.reconciled, "emptied")
        self.assertEqual(state.untracked, 0)
        self.assertEqual(state.get_state_dict()["commodities"], [])

    def test_overstated_list_is_trimmed_proportionally(self):
        self.tracker.handle(dock_event(when=-7200))
        self.tracker.handle(transfer_event(when=-7200, steel=600, tritium=400))
        self.tracker.handle(stats_event(cargo=800, when=-5))
        state = self.tracker.state
        # Пропорции сохранены, сумма точно равна достоверному тоннажу.
        self.assertEqual(sum(state.commodities.values()), 800)
        self.assertEqual(state.commodities["steel"], 480)
        self.assertEqual(state.commodities["tritium"], 320)
        self.assertEqual(state.reconciled, "trimmed")
        self.assertEqual(state.cargo_source, "estimate")
        self.assertEqual(state.untracked, 0)

    def test_rounding_keeps_the_total_exact(self):
        self.tracker.handle(dock_event(when=-7200))
        self.tracker.handle(transfer_event(when=-7200, steel=333, tritium=333, gold=334))
        self.tracker.handle(stats_event(cargo=500, when=-5))
        self.assertEqual(sum(self.tracker.state.commodities.values()), 500)

    def test_wildly_stale_list_is_dropped_not_scaled(self):
        """Ужимать 2000 t до 40 бессмысленно — честнее показать один тоннаж."""
        self.tracker.handle(dock_event(when=-7200))
        self.tracker.handle(transfer_event(when=-7200, steel=2000))
        self.tracker.handle(stats_event(cargo=40, when=-5))
        state = self.tracker.state
        self.assertEqual(state.commodities, {})
        self.assertEqual(state.reconciled, "dropped")
        self.assertEqual(state.untracked, 40)
        self.assertEqual(state.cargo_source, "estimate")

    def test_untracked_tonnage_is_reported_not_hidden(self):
        """Груз чужих командиров — это «прочее», а не повод врать про трюм."""
        self.tracker.handle(stats_event(cargo=1000, when=-120))
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(transfer_event(when=-30, steel=200))
        data = self.tracker.get_state_dict()
        self.assertEqual(data["stored"], 1200)
        self.assertEqual(data["tracked_total"], 200)
        self.assertEqual(data["untracked"], 1000)
        self.assertEqual(data["reconciled"], "")

    def test_fresh_delta_is_not_trimmed_by_its_own_tonnage(self):
        """Погрузка после CarrierStats двигает и тоннаж — резать нечего."""
        self.tracker.handle(stats_event(cargo=440, when=-60))
        self.tracker.handle(dock_event(when=-30))
        self.tracker.handle(transfer_event(when=-5, steel=700))
        state = self.tracker.state
        self.assertEqual(state.commodities["steel"], 700)
        self.assertEqual(state.stored, 1140)
        self.assertTrue(state.stored_estimated)
        self.assertEqual(state.free, 17379 - 700)
        self.assertEqual(state.cargo_capacity, 440 + 17379)

    def test_transfer_out_lowers_the_tonnage_too(self):
        self.tracker.handle(stats_event(cargo=1000, when=-60))
        self.tracker.handle(dock_event(when=-30))
        # Увозим груз, которого в поимённом списке не было (его завезли другие).
        self.tracker.handle(transfer_event(when=-5, steel=-300))
        state = self.tracker.state
        self.assertEqual(state.stored, 700)
        self.assertEqual(state.tracked_total, 0)
        self.assertEqual(state.untracked, 700)

    def test_new_stats_overwrite_the_estimate(self):
        self.tracker.handle(stats_event(cargo=440, when=-600))
        self.tracker.handle(dock_event(when=-500))
        self.tracker.handle(transfer_event(when=-400, steel=100))
        self.assertTrue(self.tracker.state.stored_estimated)
        self.tracker.handle(stats_event(cargo=90, when=-1))
        state = self.tracker.state
        self.assertFalse(state.stored_estimated)
        self.assertEqual(state.stored, 90)
        self.assertEqual(state.commodities, {"steel": 90})
        self.assertEqual(state.reconciled, "trimmed")

    def test_old_stats_never_trim_newer_journal_deltas(self):
        """Разбор старого журнала: вчерашний тоннаж не трогает сегодняшний груз."""
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(transfer_event(when=-60, steel=500))
        self.tracker.handle(stats_event(cargo=0, when=-2 * 86400))
        self.assertEqual(self.tracker.state.commodities, {"steel": 500})
        self.assertEqual(self.tracker.state.reconciled, "")

    def test_fresh_remote_snapshot_is_not_trimmed_by_old_stats(self):
        self.tracker.handle(stats_event(cargo=100, when=-3 * 86400))
        self.assertTrue(self.tracker.merge_remote({"steel": 5000}, market_id=OWN_ID))
        state = self.tracker.state
        self.assertEqual(state.commodities, {"steel": 5000})
        self.assertEqual(state.cargo_source, "remote")
        self.assertEqual(state.reconciled, "")

    def test_new_stats_trim_the_old_remote_snapshot(self):
        self.tracker.handle(dock_event(when=-7200))
        self.tracker.merge_remote({"steel": 900, "tritium": 100}, market_id=OWN_ID)
        # Снимок был час назад, Carrier Management открыли только что.
        self.tracker.state.remote_at = time.time() - 3600
        self.tracker.handle(stats_event(cargo=700, when=-1))
        state = self.tracker.state
        self.assertEqual(sum(state.commodities.values()), 700)
        self.assertFalse(state.remote_seen)
        self.assertEqual(state.cargo_source, "estimate")

    def test_trim_takes_from_cargo_we_never_carried(self):
        """Наши перевозки — самая надёжная часть списка, режем чужое."""
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(stats_event(cargo=0, when=-30))
        self.tracker.handle(transfer_event(when=-10, steel=720))
        # Снимок Raven принёс позицию, которой на борту уже нет.
        self.tracker.merge_remote({"steel": 720, "aluminium": 480}, market_id=OWN_ID)
        state = self.tracker.state
        self.assertEqual(state.commodities, {"steel": 720})
        self.assertEqual(state.reconciled, "trimmed")

    def test_old_stats_do_not_touch_a_fresh_snapshot_with_foreign_cargo(self):
        """Тоннаж суточной давности — не повод выкидывать чужой груз."""
        self.tracker.handle(stats_event(cargo=0, when=-86400))
        self.tracker.merge_remote({"steel": 720, "aluminium": 480}, market_id=OWN_ID)
        self.assertEqual(self.tracker.state.commodities, {"steel": 720, "aluminium": 480})
        self.assertEqual(self.tracker.state.reconciled, "")

    def test_spread_never_takes_more_than_a_position_holds(self):
        from carrier import CarrierState

        taken = CarrierState._spread({"a": 10, "b": 1}, 11)
        self.assertEqual(taken, {"a": 10, "b": 1})
        self.assertEqual(CarrierState._spread({"a": 10}, 0), {})
        self.assertEqual(CarrierState._spread({}, 5), {})
        taken = CarrierState._spread({"a": 3, "b": 3, "c": 3}, 4)
        self.assertEqual(sum(taken.values()), 4)

    def test_delivered_never_exceeds_on_board_in_rows(self):
        """«Завезено вами» — доля от «на борту», а не отдельная жизнь."""
        self.tracker.handle(dock_event(when=-600))
        self.tracker.handle(transfer_event(when=-600, steel=120))
        self.tracker.handle(stats_event(cargo=80, when=-1))
        data = self.tracker.get_state_dict({"steel": 500})
        row = {item["key"]: item for item in data["commodities"]}["steel"]
        self.assertEqual(row["amount"], 80)
        self.assertEqual(row["delivered"], 80)
        # Счётчик собственных доставок при этом не трогаем — это работа пилота.
        self.assertEqual(data["delivered_total"], 120)

    def test_loading_after_empty_hold_is_exact_again(self):
        self.tracker.handle(dock_event(when=-600))
        self.tracker.handle(transfer_event(when=-600, steel=2000))
        self.tracker.handle(stats_event(cargo=0, when=-300))
        self.tracker.handle(transfer_event(when=-10, steel=150))
        state = self.tracker.state
        self.assertEqual(state.commodities, {"steel": 150})
        self.assertEqual(state.stored, 150)
        self.assertEqual(state.cargo_source, "journal")

    def test_reconcile_is_idempotent(self):
        self.tracker.handle(dock_event(when=-7200))
        self.tracker.handle(transfer_event(when=-7200, steel=600, tritium=400))
        self.tracker.handle(stats_event(cargo=800, when=-5))
        snapshot = dict(self.tracker.state.commodities)
        self.assertFalse(self.tracker.state.reconcile())
        self.assertFalse(self.tracker.reconcile())
        self.assertEqual(self.tracker.state.commodities, snapshot)

    def test_without_stats_nothing_is_touched(self):
        """Чужой носитель: CarrierStats по нему не приходит, резать нечем."""
        self.tracker.handle(dock_event(market_id=OTHER_ID, when=-60, name="Чужой FC"))
        self.tracker.handle(transfer_event(market_id=OTHER_ID, when=-30, steel=250))
        self.assertFalse(self.tracker.state.reconcile())
        self.assertEqual(self.tracker.state.commodities, {"steel": 250})
        self.assertEqual(self.tracker.state.untracked, 0)

    def test_state_dict_reconciles_before_showing(self):
        """Блок CARRIER не должен показать ни одного «призрака»."""
        state = self.tracker.state
        state.stats_seen = True
        state.stored = 0
        state.stats_at = time.time()
        state.commodities = {"steel": 400}
        rows = self.tracker.get_state_dict()["commodities"]
        self.assertEqual(rows, [])
        self.assertEqual(state.reconciled, "emptied")


class RemoteSnapshotTests(unittest.TestCase):
    """Снимок Raven Colonial: адресность и пустой ответ."""

    def setUp(self):
        self.tracker = CarrierTracker()

    def test_snapshot_lands_on_the_carrier_it_was_asked_for(self):
        self.tracker.handle(dock_event(market_id=OWN_ID, when=-120))
        self.tracker.handle(dock_event(market_id=OTHER_ID, when=-10, name="Чужой FC"))
        # Ответ по первому носителю пришёл, когда мы уже улетели ко второму.
        self.assertTrue(self.tracker.merge_remote({"steel": 300}, market_id=OWN_ID))
        self.assertEqual(self.tracker.state.market_id, OTHER_ID)
        self.assertEqual(self.tracker.state.commodities, {})
        self.assertEqual(self.tracker.carriers[OWN_ID].commodities, {"steel": 300})

    def test_snapshot_without_address_goes_to_the_active_carrier(self):
        self.tracker.handle(dock_event(market_id=OWN_ID, when=-10))
        self.assertTrue(self.tracker.merge_remote({"steel": 300}))
        self.assertEqual(self.tracker.state.commodities, {"steel": 300})

    def test_empty_snapshot_is_ignored_without_confirmation(self):
        """Пустая карта у Raven значит и «нет данных» — учёт не стираем."""
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(transfer_event(when=-30, steel=120))
        self.assertFalse(self.tracker.merge_remote({}, market_id=OWN_ID, allow_empty=True))
        self.assertEqual(self.tracker.state.commodities, {"steel": 120})

    def test_empty_snapshot_clears_when_tonnage_confirms_it(self):
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(transfer_event(when=-50, steel=120))
        self.tracker.handle(stats_event(cargo=0, when=-1))
        self.assertTrue(self.tracker.merge_remote({}, market_id=OWN_ID, allow_empty=True))
        self.assertEqual(self.tracker.state.commodities, {})
        self.assertTrue(self.tracker.state.remote_seen)

    def test_empty_snapshot_clears_a_carrier_raven_already_knew(self):
        self.tracker.handle(dock_event(when=-60))
        self.tracker.merge_remote({"steel": 300}, market_id=OWN_ID)
        # Носитель разгрузили без нас: Raven отдаёт пустую карту.
        self.assertTrue(self.tracker.merge_remote({}, market_id=OWN_ID, allow_empty=True))
        self.assertEqual(self.tracker.state.commodities, {})

    def test_our_delta_beats_an_empty_snapshot(self):
        self.tracker.handle(dock_event(when=-60))
        self.tracker.merge_remote({"steel": 300}, market_id=OWN_ID)
        self.tracker.handle(transfer_event(when=0, steel=50))
        self.assertFalse(self.tracker.merge_remote({}, market_id=OWN_ID, allow_empty=True))
        self.assertEqual(self.tracker.state.commodities, {"steel": 350})

    def test_empty_snapshot_stays_ignored_by_default(self):
        self.tracker.handle(dock_event(when=-60))
        self.tracker.handle(transfer_event(when=-30, steel=120))
        self.assertFalse(self.tracker.merge_remote({}, market_id=OWN_ID))
        self.assertFalse(self.tracker.merge_remote({"steel": 0}, market_id=OWN_ID))
        self.assertEqual(self.tracker.state.commodities, {"steel": 120})


class CarrierLifecycleTests(unittest.TestCase):
    """События жизненного цикла носителя, из-за которых висели старые данные."""

    def setUp(self):
        self.tracker = CarrierTracker()

    def test_cancel_decommission_clears_the_mark(self):
        self.tracker.handle(stats_event(cargo=100, when=-60))
        self.tracker.handle({"timestamp": iso(-30), "event": "CarrierDecommission",
                             "CarrierID": OWN_ID})
        self.assertTrue(self.tracker.state.pending_decommission)
        self.assertTrue(self.tracker.handle({
            "timestamp": iso(-10), "event": "CarrierCancelDecommission", "CarrierID": OWN_ID}))
        self.assertFalse(self.tracker.state.pending_decommission)

    def test_new_carrier_starts_with_an_empty_hold(self):
        self.tracker.handle(dock_event(when=-600))
        self.tracker.handle(transfer_event(when=-500, steel=500))
        self.tracker.handle({"timestamp": iso(-1), "event": "CarrierBuy",
                             "CarrierID": OWN_ID, "Callsign": "K1F-99Z",
                             "Location": "Kuma"})
        state = self.tracker.state
        self.assertEqual(state.commodities, {})
        self.assertEqual(state.delivered, {})
        self.assertEqual(state.stored, 0)
        self.assertEqual(state.callsign, "K1F-99Z")

    def test_stats_do_not_steal_the_block_from_the_carrier_we_stand_on(self):
        """Carrier Management открывается удалённо — блок остаётся о носителе под ногами."""
        self.tracker.handle(dock_event(market_id=OTHER_ID, when=-60, name="Чужой FC"))
        self.tracker.handle(transfer_event(market_id=OTHER_ID, when=-50, steel=250))
        self.tracker.handle(stats_event(cargo=9000, when=-1))
        self.assertEqual(self.tracker.state.market_id, OTHER_ID)
        self.assertEqual(self.tracker.state.commodities, {"steel": 250})
        data = self.tracker.get_state_dict()
        self.assertEqual(data["market_id"], OTHER_ID)
        self.assertEqual([row["market_id"] for row in data["other_carriers"]], [OWN_ID])
        self.assertEqual(self.tracker.carriers[OWN_ID].stored, 9000)

    def test_stats_show_own_carrier_when_we_are_docked_nowhere(self):
        self.tracker.handle(dock_event(market_id=OTHER_ID, when=-120, name="Чужой FC"))
        self.tracker.handle({"timestamp": iso(-60), "event": "Undocked", "MarketID": OTHER_ID})
        self.tracker.handle(stats_event(cargo=500, when=-1))
        self.assertEqual(self.tracker.state.market_id, OWN_ID)
        self.assertEqual(self.tracker.state.stored, 500)

    def test_rename_does_not_touch_the_neighbour(self):
        self.tracker.handle(dock_event(market_id=OTHER_ID, when=-60, name="Чужой FC"))
        self.tracker.handle({"timestamp": iso(-1), "event": "CarrierNameChanged",
                             "CarrierID": OWN_ID, "Name": "Мой носитель"})
        self.assertEqual(self.tracker.state.market_id, OTHER_ID)
        self.assertNotEqual(self.tracker.state.name, "Мой носитель")
        self.assertEqual(self.tracker.carriers[OWN_ID].name, "Мой носитель")


class StateDictShapeTests(unittest.TestCase):
    """Поля, по которым блок CARRIER рисует честную подпись."""

    def test_new_fields_are_present_and_typed(self):
        data = CarrierState().get_state_dict()
        for key in ("untracked", "stored_estimated", "reconciled", "cargo_source", "stats_age"):
            self.assertIn(key, data)
        self.assertEqual(data["untracked"], 0)
        self.assertFalse(data["stored_estimated"])
        self.assertEqual(data["cargo_source"], "")

    def test_stats_age_is_in_minutes(self):
        """Возраст в минутах: с секундами хеш оверлея менялся бы каждый тик."""
        state = CarrierState()
        state.stats_seen = True
        state.stats_at = time.time() - 3700
        self.assertEqual(state.get_state_dict()["stats_age"], 61)

    def test_source_label_follows_the_data(self):
        tracker = CarrierTracker()
        tracker.handle(dock_event(when=-60))
        self.assertEqual(tracker.state.cargo_source, "")
        tracker.handle(transfer_event(when=-50, steel=100))
        self.assertEqual(tracker.state.cargo_source, "journal")
        tracker.merge_remote({"steel": 400}, market_id=OWN_ID)
        self.assertEqual(tracker.state.cargo_source, "remote")


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
class CarrierOverlayReconcileTests(unittest.TestCase):
    """Что именно видит пилот в блоке CARRIER после сверки."""

    def setUp(self):
        from unittest import mock

        from test_overlay_management import _ensure_gui_stubs

        _ensure_gui_stubs()
        import overlay as overlay_module

        self.overlay_module = overlay_module
        self.texts = {}

        def label_factory(*args, **kwargs):
            widget = mock.MagicMock(name="Label")
            widget.text_arg = str(kwargs.get("text", ""))

            def _config(*c_args, **c_kwargs):
                if "text" in c_kwargs:
                    widget.text_arg = str(c_kwargs["text"])

            widget.config.side_effect = _config
            return widget

        patcher = mock.patch.object(overlay_module.tk, "Label", side_effect=label_factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        frame_patcher = mock.patch.object(overlay_module.tk, "Frame",
                                          side_effect=lambda *a, **k: mock.MagicMock(name="Frame"))
        frame_patcher.start()
        self.addCleanup(frame_patcher.stop)

    def _overlay(self):
        from test_overlay_layout import _FakeMaster

        return self.overlay_module.CarrierOverlay(
            _FakeMaster(), {"font_family": "Consolas", "font_size": 10})

    @staticmethod
    def _state(**overrides):
        data = {
            "stats_seen": True, "stored": 1000, "cargo_capacity": 18000, "free": 17000,
            "fill_percent": 5, "commodities": [], "tracked_total": 0, "delivered_total": 0,
            "untracked": 0, "stored_estimated": False, "reconciled": "", "cargo_source": "",
        }
        data.update(overrides)
        return data

    def test_untracked_tonnage_is_shown_as_other(self):
        block = self._overlay()
        block.update_carrier(self._state(untracked=800, tracked_total=200, commodities=[
            {"key": "steel", "name": "Steel", "amount": 200, "delivered": 0,
             "need": 0, "remaining": 0}]))
        self.assertIn("прочее 800 t", block.detail_label.text_arg)

    def test_estimated_tonnage_is_marked(self):
        block = self._overlay()
        block.update_carrier(self._state(stored_estimated=True))
        self.assertTrue(block.total_label.text_arg.startswith("≈"))
        block.update_carrier(self._state(stored_estimated=False))
        self.assertFalse(block.total_label.text_arg.startswith("≈"))

    def test_source_line_says_the_list_was_reconciled(self):
        block = self._overlay()
        block.update_carrier(self._state(cargo_source="estimate", tracked_total=700,
                                         reconciled="trimmed"))
        self.assertIn("оценка, сведена с CarrierStats", block.summary_label.text_arg)

    def test_empty_list_explains_itself(self):
        block = self.overlay_module.CarrierOverlay
        self.assertIn("Трюм пуст", block._empty_text({"stats_seen": True, "stored": 0}))
        self.assertIn("Состав груза неизвестен", block._empty_text(
            {"stats_seen": True, "stored": 900, "reconciled": "dropped"}))
        self.assertIn("Нет данных по товарам", block._empty_text({"stats_seen": False}))
        self.assertIn("Нет данных по товарам", block._empty_text({}))

    def test_empty_label_text_changes_between_states(self):
        """Текст создавался один раз — «трюм пуст» никогда бы не показался."""
        block = self._overlay()
        block.update_carrier(self._state(stored=0, commodities=[]))
        self.assertIn("Трюм пуст", block._empty_label.text_arg)
        block.update_carrier(self._state(stored=900, reconciled="dropped", commodities=[]))
        self.assertIn("Состав груза неизвестен", block._empty_label.text_arg)

    def test_manager_updates_the_block_even_with_empty_data(self):
        """Иначе блок замирал на прошлом состоянии — с прежними строками."""
        import tempfile
        from pathlib import Path as _Path
        from unittest import mock

        from test_overlay_layout import _FakeMaster

        with tempfile.TemporaryDirectory() as tmp:
            manager = self.overlay_module.OverlayManager(
                _FakeMaster(), _Path(tmp) / "config.json")
            try:
                manager.carrier_overlay = mock.MagicMock()
                manager._apply_update({"carrier": {"stored": 100}})
                manager._apply_update({})
                manager._apply_update({"carrier": {}})
            finally:
                manager._stop.set()
        passed = [call.args[0] for call
                  in manager.carrier_overlay.update_carrier.call_args_list]
        self.assertEqual(passed, [{"stored": 100}, {}, {}])


# ---------------------------------------------------------------------------
class AppGhostCargoTests(unittest.TestCase):
    """Связка «журнал + Raven -> блок CARRIER» на уровне приложения."""

    def setUp(self):
        from test_carrier import CarrierOverlayIntegrationTests

        self.case = CarrierOverlayIntegrationTests
        self.case.setUp(self)

    def tearDown(self):
        self.case.tearDown(self)

    def _inline(self):
        return self.case._run_threads_inline(self)

    def test_empty_raven_answer_does_not_wipe_journal_accounting(self):
        """Raven молчит про носитель — это не повод стирать наш учёт."""
        self.app.carrier.handle(dock_event(when=-60))
        self.app.carrier.handle(transfer_event(when=-30, steel=120))
        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": True, "data": {}}
        with self._inline():
            self.app._load_carrier_cargo(OWN_ID)
        self.assertEqual(self.app.carrier.state.commodities, {"steel": 120})

    def test_explicit_empty_cargo_clears_a_confirmed_empty_hold(self):
        self.app.carrier.handle(dock_event(when=-60))
        self.app.carrier.handle(transfer_event(when=-50, steel=120))
        self.app.carrier.handle(stats_event(cargo=0, when=-1))
        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": True, "data": {"cargo": {}}}
        with self._inline():
            self.app._load_carrier_cargo(OWN_ID)
        self.assertEqual(self.app.carrier.state.commodities, {})

    def test_late_answer_does_not_pollute_the_carrier_we_moved_to(self):
        """Пока запрос летел, пилот перестыковался — чужие тонны не наши."""
        self.app.carrier.handle(dock_event(market_id=OWN_ID, when=-120))
        self.app.raven_api.get_fc_cargo = lambda market_id: {
            "ok": True, "data": {"cargo": {"steel": 400}}}
        self.app.carrier.handle(dock_event(market_id=OTHER_ID, when=-10, name="Чужой FC"))
        with self._inline():
            self.app._load_carrier_cargo(OWN_ID)
        self.assertEqual(self.app.carrier.state.market_id, OTHER_ID)
        self.assertEqual(self.app.carrier.state.commodities, {})
        self.assertEqual(self.app.carrier.carriers[OWN_ID].commodities, {"steel": 400})

    def test_ghost_rows_are_gone_from_overlay_data(self):
        """Сквозной сценарий жалобы: старые строки после открытия управления."""
        self.app.carrier.handle(dock_event(when=-2 * 86400))
        self.app.carrier.handle(transfer_event(when=-2 * 86400, steel=900, tritium=300))
        rows = self.app._get_overlay_data()["carrier"]["commodities"]
        self.assertEqual(len(rows), 2)

        self.app.carrier.handle(stats_event(cargo=0, when=-1))
        data = self.app._get_overlay_data()["carrier"]
        self.assertEqual(data["commodities"], [])
        self.assertEqual(data["stored"], 0)
        self.assertEqual(data["reconciled"], "emptied")

    def test_restore_applies_journal_files_chronologically(self):
        """Файлы читаются от новых к старым — события должны идти наоборот."""
        import os

        older = self.app.journal_path / "Journal.260101000000.01.log"
        newer = self.app.journal_path / "Journal.260102000000.01.log"
        older.write_text(
            '{"timestamp":"2026-01-01T10:00:00Z","event":"Docked","StationType":"FleetCarrier",'
            '"StationName":"Старый FC","MarketID":3700009999,"StarSystem":"Kuma"}\n',
            encoding="utf-8")
        newer.write_text(
            '{"timestamp":"2026-01-02T10:00:00Z","event":"Docked","StationType":"FleetCarrier",'
            '"StationName":"FC Spirula","MarketID":3700005632,"StarSystem":"Hermitage"}\n',
            encoding="utf-8")
        os.utime(older, (1_760_000_000, 1_760_000_000))
        os.utime(newer, (1_760_100_000, 1_760_100_000))

        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": False, "error": "тест"}
        with self._inline():
            restored = self.app._restore_station_state_from_journal()

        self.assertTrue(restored["carrier"])
        # Последним по времени был свой носитель — он и активен.
        self.assertEqual(self.app.carrier.state.market_id, OWN_ID)
        self.assertTrue(self.app.carrier.state.at_carrier)
        self.assertFalse(self.app.carrier.carriers[OTHER_ID].at_carrier)
