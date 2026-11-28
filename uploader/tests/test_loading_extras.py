"""Helper consumes inclusive loading targets from the API, not raw recipe amounts."""
from copy import deepcopy
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loading_patterns import LoadingPatternState, loading_tables, loading_segments


def payload():
    return {
        'ok': True,
        'pattern': {'pattern': {
            'name': 'With reserve', 'allocations': {'123': {'steel': 12, 'water': 7}},
            'extras': {'123': {'steel': 2, 'water': 2}},
        }},
        'progress': {
            'total': 19, 'assigned': 19, 'loaded': 15, 'unknown': 0, 'unassigned': 0,
            'carriers': [{
                'carrierId': '123', 'name': 'Alpha', 'target': 19, 'loaded': 15, 'known': True,
                'items': [
                    {'commodity': 'steel', 'name': 'Steel', 'required': 12, 'loaded': 10, 'remaining': 2},
                    {'commodity': 'water', 'name': 'Water', 'required': 7, 'loaded': 5, 'remaining': 2},
                ],
            }],
        },
    }


class LoadingExtrasTests(unittest.TestCase):
    def test_helper_does_not_report_recipe_only_stock_as_fully_loaded(self):
        data = payload()
        before = deepcopy(data)
        table = loading_tables(data)[0]
        self.assertEqual(table['target'], 19)
        self.assertEqual(table['loaded'], 15)
        self.assertEqual(table['remaining'], 4)
        self.assertEqual([row['remaining'] for row in table['rows']], [2, 2])
        self.assertLess(loading_segments(15, 19), 20)
        self.assertEqual(data, before)

    def test_unknown_reserve_targets_stay_unknown_and_selection_is_isolated(self):
        data = payload()
        for item in data['progress']['carriers'][0]['items']:
            item.update(loaded=None, remaining=None)
        table = loading_tables(data)[0]
        self.assertEqual(table['unknown'], 19)
        self.assertIsNone(table['loaded'])
        self.assertIsNone(table['remaining'])
        self.assertTrue(all(row['remaining'] is None for row in table['rows']))
        data['carrier_id'] = '456'
        self.assertEqual(loading_tables(data), [])

    def test_cached_api_response_keeps_extra_targets_without_rewriting_it(self):
        state = LoadingPatternState()
        state.prepare('account', 'pattern')
        data = payload()
        self.assertTrue(state.accept('account', 'pattern', data))
        result = state.snapshot('account', 'pattern', '123')
        self.assertEqual(result['pattern']['pattern']['extras']['123']['steel'], 2)
        self.assertEqual(loading_tables(result)[0]['target'], 19)
        result['pattern']['pattern']['extras']['123']['steel'] = 900
        self.assertEqual(state.snapshot('account', 'pattern')['pattern']['pattern']['extras']['123']['steel'], 2)


if __name__ == '__main__':
    unittest.main()
