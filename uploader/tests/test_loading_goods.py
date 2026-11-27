"""Display-only grouping must not change stock maths or unknown quantities."""
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from loading_goods import CATEGORIES, GOODS, ORDERS, project_goods, display_options, valid_display_option
from loading_patterns import loading_tables
from test_loading_patterns import payload
import build_bundle


class LoadingGoodsTests(unittest.TestCase):
    def test_sorts_filters_unknowns_and_no_mutation(self):
        rows = [dict(commodity=key, name=key, required=qty, remaining=rem)
                for key, qty, rem in [("water", 50, 40), ("steel", 100, 0), ("computercomponents", 10, None)]]
        before = deepcopy(rows)
        def keys(mode, **kw):
            return [r["commodity"] for r in project_goods(rows, mode, **kw)]
        self.assertEqual(keys("category"), ["steel", "computercomponents", "water"])
        self.assertEqual(keys("remaining"), ["computercomponents", "water", "steel"])
        self.assertEqual(keys("quantity"), ["steel", "water", "computercomponents"])
        self.assertEqual(keys("recipe"), ["computercomponents", "steel", "water"])
        self.assertEqual(keys("category", category="Metals"), ["steel"])
        self.assertEqual(keys("name", query=" STEEL "), ["steel"])
        self.assertEqual(keys("name", query="not a good"), [])
        self.assertEqual(rows, before)

    def test_every_filter_keeps_totals_and_unknown_semantics(self):
        data = payload()
        before = deepcopy(data)
        full = loading_tables(data, True)
        for order in ORDERS:
            for category in ["", "Metals", "Technology", "future category"]:
                filtered = loading_tables(data, order=order, category=category)
                for original, result in zip(full, filtered):
                    for key in ("loaded", "target", "remaining", "unknown", "carrierId"):
                        self.assertEqual(original[key], result[key])
                    for row in result["rows"]:
                        if row["commodity"] == "water":
                            self.assertIsNone(row["loaded"])
                            self.assertIsNone(row["remaining"])
        self.assertEqual(data, before)
        self.assertTrue(loading_tables(data, order="category")[0]["grouped"])

    def test_shared_resource_is_packaged_and_all_options_are_validated(self):
        root = Path(__file__).resolve().parents[1]
        self.assertIn("loading_goods.json", build_bundle.bundle_files(root))
        self.assertIn("loading_goods.py", build_bundle.bundle_files(root))
        self.assertEqual(json.loads((root / "loading_goods.json").read_text())["goods"], GOODS)
        for key, _text, choices, _value in display_options({}):
            for value, _title in choices:
                self.assertTrue(valid_display_option(key, value))
        self.assertFalse(valid_display_option("loading_goods_order", True))
        self.assertFalse(valid_display_option("loading_goods_order", "invalid"))
        self.assertFalse(valid_display_option("loading_goods_category", "invalid"))
        self.assertFalse(valid_display_option("anything", "category"))
        self.assertIn("Other", CATEGORIES)
