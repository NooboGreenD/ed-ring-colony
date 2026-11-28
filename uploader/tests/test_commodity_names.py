"""Commodity display localization; no Qt runtime or personal journal fixtures."""
import ast
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
import sys
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_bundle
from commodity_names import CATALOG, GOODS, commodity_label, known_commodity_key
from i18n import current_locale, set_locale, tr
from overlay_options import filter_carrier_rows, option_key
from system_map import commodity_label as report_label

ROOT = Path(__file__).resolve().parents[1]


class CommodityNamesTests(unittest.TestCase):
    def setUp(self):
        self.locale = current_locale()
        set_locale('ru')

    def tearDown(self):
        set_locale(self.locale)

    def test_every_construction_good_has_a_name_in_every_supported_locale(self):
        for key in CATALOG['construction']:
            self.assertRegex(GOODS[key]['ru'], '[А-Яа-я]')
            for locale in ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja']:
                with self.subTest(key=key, locale=locale):
                    self.assertTrue(commodity_label(key, locale=locale))
                    self.assertNotEqual(commodity_label(key, locale=locale), key)

    def test_game_names_tokens_aliases_and_unknown_fallback(self):
        for key, label in {
            'autofabricators': 'Автосинтезаторы', 'buildingfabricators': 'Строительные синтезаторы',
            'agriculturalmedicines': 'Ветмедикаменты', 'mutomimager': 'Мюонное видеоустройство',
            'cropharvesters': 'Уборочный комбайн', 'ceramiccomposites': 'Керамокомпозиты',
            'steel': 'Сталь', 'tritium': 'Тритий',
        }.items():
            self.assertEqual(commodity_label(key), label)
            self.assertEqual(report_label(key), label)
        for raw in ['$AutoFabricators_Name;', 'Auto-Fabricators', 'Автофабрикаторы', 'Автосинтезаторы']:
            self.assertEqual(known_commodity_key(raw), 'autofabricators')
            self.assertEqual(commodity_label(raw), 'Автосинтезаторы')
        self.assertEqual(commodity_label('Helium3', 'Гелий-3'), 'Гелий-3')
        self.assertEqual(commodity_label('Helium3', 'Гелий-3', locale='en'), 'Helium-3')
        self.assertEqual(commodity_label('future', 'Новый товар'), 'Новый товар')
        self.assertEqual(commodity_label('Future Good'), 'Future Good')
        set_locale('en')
        self.assertEqual(commodity_label('steel', 'Сталь'), 'Steel')
        self.assertEqual(commodity_label('Автофабрикаторы'), 'Auto-Fabricators')
        self.assertEqual(report_label('powergenerators'), 'Power Generators')

    def test_carrier_search_matches_ui_name_without_mutating_journal_names(self):
        rows = [{'key': 'autofabricators', 'name': 'Auto-Fabricators', 'amount': 12, 'need': 20, 'remaining': 8}]
        before = deepcopy(rows)
        self.assertEqual(filter_carrier_rows(rows, query='автосинтез'), rows)
        self.assertEqual(filter_carrier_rows(rows, query='auto'), rows)
        set_locale('en')
        rows[0]['name'] = 'Автофабрикаторы'
        self.assertEqual(filter_carrier_rows(rows, query='Auto-Fabricators'), rows)
        rows[0]['name'] = before[0]['name']
        self.assertEqual(rows, before)

    def test_shared_data_is_in_helper_update_bundle(self):
        files = build_bundle.bundle_files(ROOT)
        self.assertIn('commodity_names.py', files)
        self.assertIn('commodity_names.json', files)

    def test_actual_overlay_render_methods_localize_pooled_rows_after_locale_switch(self):
        # Execute actual production methods with fake widgets, not Qt imports.
        tree = ast.parse((ROOT / 'overlay_blocks.py').read_text(encoding='utf-8'))
        methods = [n for cls in tree.body if isinstance(cls, ast.ClassDef)
                   and cls.name in ('CargoOverlay', 'CarrierOverlay')
                   for n in cls.body if isinstance(n, ast.FunctionDef)
                   and n.name in ('_render_cargo_rows', '_render_rows')]
        env = dict(commodity_label=commodity_label, option_key=option_key, tr=tr, paint=Mock())
        for color in ['COLOR_ACCENT', 'COLOR_RED_TEXT', 'COLOR_TEXT', 'COLOR_GREEN_TEXT', 'COLOR_TEXT_MUTED']:
            env[color] = color
        for method in methods:
            exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<actual-overlay>', 'exec'), env)
        cargo_entry = {key: Mock() for key in ['frame', 'name', 'count', 'icon']}
        cargo = SimpleNamespace(_cargo_pool=[cargo_entry], _cargo_order=[], empty_label=Mock())
        cells = {key: Mock() for key in ['name', 'board', 'need', 'tail']}
        carrier = SimpleNamespace(_empty_label=Mock(), _row_pool=[{'frame': Mock(), 'cells': cells}],
                                  _row_order=[], _name_chars=100, settings={}, _last_carrier_data={})
        inventory = [{'Name': 'autofabricators', 'Name_Localised': 'Auto-Fabricators', 'Count': 12}]
        rows = [{'key': 'buildingfabricators', 'name': 'Building Fabricators', 'amount': 12}]
        before = deepcopy((inventory, rows))
        for locale, cargo_name, carrier_name in [
            ('ru', 'Автосинтезаторы', 'Строительные синтезаторы'),
            ('en', 'Auto-Fabricators', 'Building Fabricators'),
            ('ru', 'Автосинтезаторы', 'Строительные синтезаторы'),
        ]:
            set_locale(locale)
            env['_render_cargo_rows'](cargo, inventory)
            env['_render_rows'](carrier, rows)
            cargo_entry['name'].setText.assert_called_with(cargo_name)
            cells['name'].setText.assert_called_with(carrier_name)
        self.assertEqual((inventory, rows), before)


if __name__ == '__main__':
    unittest.main()
