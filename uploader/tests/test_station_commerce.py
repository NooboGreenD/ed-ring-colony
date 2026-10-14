import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from station_commerce import StationCommerceCollector

STAMP = '2026-01-01T00:00:00Z'


class Api:
    is_connected = True

    def __init__(self, ok=True):
        self.ok = ok
        self.sent = []

    def upload_station_reports(self, reports):
        self.sent.extend(reports)
        return {"ok": self.ok}


class StationCommerceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.collector = StationCommerceCollector(self.root / 'outbox.json')
        self.collector.feed({"event": "Location", "StarSystem": "Sol", "StarPos": [0, 0, 0], "timestamp": STAMP, "Docked": False})
        self.collector.feed({"event": "Docked", "StarSystem": "Sol", "StationName": "Galileo", "MarketID": 123, "StationType": "Coriolis", "timestamp": STAMP})

    def sidecar(self, name='Market', **fields):
        event = {"event": name, "timestamp": STAMP, "StarSystem": "Sol", "StationName": "Galileo", "MarketID": 123, **fields}
        (self.root / (name + '.json')).write_text(json.dumps(event), encoding='utf-8')
        return event

    def test_docking_is_metadata_only_and_missing_file_does_not_clear_inventory(self):
        self.collector.read_files(self.root)
        report = list(self.collector.pending.values())[0]
        self.assertEqual(report['inventories'], {})
        self.assertEqual([report['x'], report['y'], report['z']], [0, 0, 0])

    def test_full_market_normalizes_prices_stock_and_explicit_empty_snapshot(self):
        self.sidecar(Items=[{"Name": "steel", "Stock": 300, "BuyPrice": 100, "SellPrice": 80, "Demand": 10}])
        self.collector.read_files(self.root)
        items = self.collector.pending['123:market']['inventories']['market']['items']
        self.assertEqual(items[0], {"name": "steel", "stock": 300, "buyPrice": 100, "sellPrice": 80, "demand": 10})
        self.collector.feed(self.sidecar(Items=[], timestamp='2026-01-02T00:00:00Z'))
        self.assertEqual(self.collector.pending['123:market']['inventories']['market']['items'], [])

    def test_module_ship_snapshots_remain_independent(self):
        self.sidecar('Outfitting', Items=[{"Name": "int_hyperdrive_size5_class5", "BuyPrice": 1000, "id": 22}])
        self.sidecar('Shipyard', ShipsHere=[{"ShipType": "sidewinder", "ShipPrice": 32000, "id": 23}])
        self.collector.read_files(self.root)
        self.assertEqual(self.collector.pending['123:shipyard']['inventories']['shipyard']['items'][0]['price'], 32000)
        self.assertEqual(self.collector.pending['123:outfitting']['inventories']['outfitting']['items'][0]['name'], 'int_hyperdrive_size5_class5')
        self.assertNotIn('123:market', self.collector.pending)

    def test_old_or_wrong_station_sidecar_is_not_attached_to_current_dock(self):
        self.sidecar(Items=[], MarketID=999)
        self.collector.read_files(self.root)
        self.assertNotIn('123:market', self.collector.pending)
        self.sidecar(Items=[], StarSystem='Alpha')
        self.collector.read_files(self.root)
        self.assertNotIn('123:market', self.collector.pending)
        self.collector.feed({"event": "FSDJump", "StarSystem": "Alpha", "StarPos": [10, 20, 30], "timestamp": STAMP})
        self.collector.read_files(self.root)
        self.assertNotIn('123:market', self.collector.pending)

    def test_failure_retries_after_restart_without_requiring_new_journal_event(self):
        self.collector.feed(self.sidecar(Items=[{"Name": "water", "Stock": 10}]))
        self.collector.flush(Api(ok=False))
        restored = StationCommerceCollector(self.root / 'outbox.json')
        self.assertIn('123:market', restored.pending)
        api = Api()
        restored.flush(api)
        self.assertEqual(restored.pending, {})
        self.assertEqual(len(api.sent), 2)
        self.assertEqual(StationCommerceCollector(self.root / 'outbox.json').pending, {})

    def test_docking_on_new_station_does_not_reuse_market_id_or_body_metadata(self):
        self.collector.feed({"event": "Docked", "StarSystem": "Sol", "StationName": "Other", "timestamp": STAMP})
        report = self.collector.pending['Sol:Other:metadata']
        self.assertNotIn('market_id', report)
        self.assertEqual(report['metadata'], {})

    def test_historical_inventory_uses_its_observation_time_and_inline_data_only(self):
        self.collector.feed(self.sidecar(Items=[{"Name": "water", "Stock": 2}]), live=False)
        report = self.collector.pending['123:market']
        self.assertEqual(report['inventories']['market']['observed_at'], STAMP)
        self.assertNotIn('123:outfitting', self.collector.pending)


if __name__ == '__main__':
    unittest.main()
