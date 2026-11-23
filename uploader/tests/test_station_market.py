"""Current station sale highlights: no Qt, network or production data required."""
import ast
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from station_market import StationMarketAvailability
from station_commerce import StationCommerceCollector
from i18n import tr
from overlay_options import CONTENT_OPTIONS, CONTENT_DEFAULTS, option_key
from unittest import mock

DOCK = {"event": "Docked", "timestamp": "2026-01-01T10:00:00Z", "MarketID": 123,
        "StationName": "Galileo", "StarSystem": "Sol"}
MARKET = {**DOCK, "event": "Market", "timestamp": "2026-01-01T10:01:00Z",
          "Items": [{"Name": "$Steel_Name;", "Stock": 30, "BuyPrice": 100, "Producer": True}]}
CARGO = {"stored": 15, "need_total": 120, "commodities": [
    {"key": "steel", "name": "Steel", "amount": 15, "need": 100, "remaining": 85},
    {"key": "water", "name": "Water", "amount": 0, "need": 20, "remaining": 20},
]}


def source_method(filename, cls, method):
    """Execute the real method body with lightweight widget stubs on Qt-less CI.

    This is not a screenshot/Qt integration test. The Qt suite exercises the
    same pooled widgets on environments with the platform runtime installed.
    """
    tree = ast.parse((HERE.parent / filename).read_text(encoding="utf-8"))
    owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls)
    func = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == method)
    return ast.Module(body=[func], type_ignores=[])


class StationMarketTests(unittest.TestCase):
    def setUp(self):
        self.market = StationMarketAvailability()
        self.market.handle(DOCK)

    def view(self):
        return self.market.decorate_carrier(CARGO)

    def test_only_station_sale_stock_matches_canonical_keys_without_changing_carrier_totals(self):
        original = copy.deepcopy(CARGO)
        self.market.handle(MARKET, live=True)
        view = self.view()
        self.assertTrue(view["commodities"][0]["station_sells"])
        self.assertEqual(view["commodities"][0]["station_stock"], 30)
        self.assertFalse(view["commodities"][1]["station_sells"])
        self.assertEqual(view["need_total"],120)
        self.assertEqual(CARGO, original)
        self.assertEqual(view["station_market"]["station_name"], "Galileo")

    def test_buy_orders_zero_stock_zero_price_and_nonfinite_values_do_not_highlight(self):
        for fields in ({"Stock": 0}, {"BuyPrice": 0}, {"Producer": False},
                       {"Stock": -1}, {"Stock": float('inf')}, {"BuyPrice": float('nan')},
                       {"Stock": True}, {"BuyPrice": "100"}, {"Stock": None}):
            with self.subTest(fields=fields):
                self.market.handle({**MARKET,"Items":[{**MARKET['Items'][0],**fields,"Demand":1000,"SellPrice":100}]},live=True)
                self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_old_snapshots_without_flags_work_but_demand_only_does_not(self):
        self.market.handle({**MARKET,"Items":[{"Name":"steel","BuyPrice":10,"Stock":5}]},live=True)
        self.assertTrue(self.view()["commodities"][0]["station_sells"])
        self.market.handle({**MARKET,"Items":[{"Name":"steel","SellPrice":10,"Demand":500}]},live=True)
        self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_wrong_market_system_or_station_never_applies(self):
        for fields in ({"MarketID":999},{"StarSystem":"Alpha"},{"StationName":"Other"}):
            self.market.handle({**MARKET,**fields},live=True)
            self.assertFalse(self.view()["station_market"]["known"])

    def test_no_history_or_outbox_snapshot_is_used_as_current_market(self):
        self.market.handle(MARKET,live=False)
        self.assertFalse(self.view()["station_market"]["known"])
        self.market.handle(MARKET,live=True)
        self.assertTrue(self.view()["station_market"]["known"])

    def test_undock_jump_exit_and_pilot_change_clear_all_highlights(self):
        for event in ("Undocked","FSDJump","SupercruiseEntry","Shutdown","Commander","LoadGame"):
            with self.subTest(event=event):
                self.market.handle(DOCK)
                self.market.handle(MARKET,live=True)
                self.market.handle({"event":event})
                self.assertFalse(self.view()["station_market"]["docked"])
                self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_redocking_and_carrier_jump_cannot_reuse_previous_visit_snapshot(self):
        for dock in ({**DOCK,"timestamp":"2026-01-01T11:00:00Z"},
                     {**DOCK,"event":"CarrierJump","Docked":True,"StarSystem":"Alpha"},
                     {**DOCK,"event":"Location","Docked":False}):
            self.market.handle(DOCK)
            self.market.handle(MARKET,live=True)
            self.market.handle(dock)
            self.market.handle(MARKET,live=True)
            self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_bad_or_older_market_file_does_not_clear_valid_data_but_explicit_empty_does(self):
        self.market.handle(MARKET,live=True)
        for fields in ({"Items":None},{"Items":[{}]},{"timestamp":"broken"},
                       {"timestamp":"2026-01-01T09:59:00Z"},{"timestamp":"2999-01-01T00:00:00Z"}):
            self.market.handle({**MARKET,**fields},live=True)
            self.assertTrue(self.view()["commodities"][0]["station_sells"])
        self.market.handle({**MARKET,"Items":[]},live=True)
        self.assertTrue(self.view()["station_market"]["known"])
        self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_buy_last_units_removes_highlight_and_older_sidecar_cannot_restore_it(self):
        self.market.handle(MARKET,live=True)
        buy = {"event":"MarketBuy","MarketID":123,"Type":"steel","Count":20,
               "timestamp":"2026-01-01T10:02:00Z"}
        self.market.handle(buy,live=True)
        self.market.handle(buy,live=True)  # journal duplicate
        self.assertEqual(self.view()["commodities"][0]["station_stock"],10)
        self.market.handle({**buy,"Count":10,"timestamp":"2026-01-01T10:03:00Z"},live=True)
        self.market.handle(MARKET,live=True)
        self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_historical_or_foreign_purchase_does_not_deplete_current_stock(self):
        self.market.handle(MARKET,live=True)
        buy={"event":"MarketBuy","MarketID":999,"Type":"steel","Count":30,"timestamp":"2026-01-01T10:02:00Z"}
        self.market.handle(buy,live=True)
        self.market.handle({**buy,"MarketID":123},live=False)
        self.assertEqual(self.view()["commodities"][0]["station_stock"],30)


class StationMarketSidecarTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)
        self.collector=StationCommerceCollector(self.path/'outbox.json')
        self.collector.feed(DOCK,live=False)

    def view(self):
        return self.collector.market_availability.decorate_carrier(CARGO)

    def write(self,event):
        (self.path/'Market.json').write_text(json.dumps(event),encoding='utf-8')

    def test_offline_sidecar_updates_hud_without_waiting_for_report_upload(self):
        self.write(MARKET)
        self.collector.read_files(self.path)
        self.assertTrue(self.view()["commodities"][0]["station_sells"])
        self.assertIn('123:market',self.collector.pending)
        restored=StationCommerceCollector(self.path/'outbox.json')
        self.assertFalse(restored.market_availability.decorate_carrier(CARGO)["station_market"]["known"])

    def test_wrong_or_previous_visit_sidecar_and_undock_do_not_leave_highlights(self):
        self.write({**MARKET,"MarketID":999})
        self.collector.read_files(self.path)
        self.assertFalse(self.view()["station_market"]["known"])
        self.write(MARKET)
        self.collector.read_files(self.path)
        self.assertTrue(self.view()["station_market"]["known"])
        self.collector.feed({"event":"Undocked"},live=True)
        self.collector.read_files(self.path)
        self.assertFalse(self.view()["commodities"][0]["station_sells"])
        self.collector.feed({**DOCK,"timestamp":"2026-01-01T12:00:00Z"},live=True)
        self.collector.read_files(self.path)
        self.assertFalse(self.view()["commodities"][0]["station_sells"])

    def test_live_inline_inventory_updates_market_but_journal_marker_without_items_does_not_erase(self):
        self.collector.feed(MARKET,live=True)
        self.collector.feed({**MARKET,"Items":None},live=True)
        self.assertTrue(self.view()["commodities"][0]["station_sells"])


class FakeWidget:
    def __init__(self):
        self.text='';self.style='';self.tooltip='';self.visible=False
    def setText(self,value): self.text=value
    def setStyleSheet(self,value): self.style=value
    def setToolTip(self,value): self.tooltip=value
    def hide(self): self.visible=False
    def show(self): self.visible=True


class CarrierMarketRenderingTests(unittest.TestCase):
    def setUp(self):
        constants={"COLOR_TEXT":"normal","COLOR_TEXT_MUTED":"muted","COLOR_RED_TEXT":"red",
                   "COLOR_GREEN_TEXT":"green","COLOR_ACCENT":"orange"}
        def paint(widget,color=None,background=None): widget.style=(color,background)
        env={**constants,"tr":tr,"paint":paint,"option_key":option_key}
        exec(compile(source_method('overlay_blocks.py','CarrierOverlay','_render_rows'),'<carrier-render>','exec'),env)
        self.render=env['_render_rows']
        self.overlay=SimpleNamespace(settings={},_empty_label=FakeWidget(),_row_pool=[],_row_order=[],_name_chars=40,
                                     _last_carrier_data={"station_market":{"station_name":"Galileo"}})
        self.overlay._make_row=lambda:{"frame":FakeWidget(),"cells":{key:FakeWidget() for key in ('name','board','need','tail')}}

    def test_highlights_name_and_row_but_preserves_need_colors_and_resets_reused_widgets(self):
        row={**CARGO['commodities'][0],"station_sells":True,"station_stock":30}
        self.render(self.overlay,[row])
        entry=self.overlay._row_pool[0]
        self.assertEqual(entry['cells']['name'].text,'● Steel')
        self.assertEqual(entry['cells']['name'].style[0],'green')
        self.assertEqual(entry['cells']['tail'].style[0],'red')
        self.assertEqual(entry['cells']['tail'].text,'-85')
        self.assertIn('30',entry['frame'].tooltip)
        self.render(self.overlay,[{**row,"station_sells":False}])
        self.assertIs(self.overlay._row_pool[0],entry)
        self.assertEqual(entry['cells']['name'].text,'Steel')
        self.assertEqual(entry['cells']['name'].style,('normal','transparent'))
        self.assertEqual(entry['frame'].tooltip,'')
        self.assertEqual(entry['frame'].style,'background:transparent;')

    def test_toggle_clears_highlight_and_tooltip_and_restores_without_new_market_data(self):
        row={**CARGO['commodities'][0],"station_sells":True,"station_stock":30}
        self.render(self.overlay,[row])
        entry=self.overlay._row_pool[0]
        self.overlay.settings['overlay_carrier_station_market']=False
        self.render(self.overlay,[row])
        self.assertEqual(entry['cells']['name'].text,'Steel')
        self.assertEqual(entry['cells']['name'].style,('normal','transparent'))
        self.assertEqual(entry['frame'].tooltip,'')
        self.assertEqual(entry['cells']['tail'].text,'-85')
        self.overlay.settings['overlay_carrier_station_market']=True
        self.render(self.overlay,[row])
        self.assertEqual(entry['cells']['name'].text,'● Steel')
        self.assertIn('30',entry['frame'].tooltip)
        self.assertTrue(row['station_sells'])  # display option never erases source data

    def test_filter_reorder_and_empty_list_do_not_reuse_previous_goods_highlight(self):
        self.render(self.overlay,[{**CARGO['commodities'][0],"station_sells":True}])
        self.render(self.overlay,[CARGO['commodities'][1]])
        self.assertEqual(self.overlay._row_pool[0]['cells']['name'].text,'Water')
        self.assertEqual(self.overlay._row_pool[0]['cells']['name'].style[0],'normal')
        self.render(self.overlay,[],empty_text='empty')
        self.assertFalse(self.overlay._row_pool[0]['frame'].visible)
        self.assertTrue(self.overlay._empty_label.visible)


class CarrierMarketSettingsTests(unittest.TestCase):
    def test_option_is_registered_and_enabled_by_default(self):
        self.assertIn('station_market', CONTENT_OPTIONS['carrier'])
        self.assertTrue(CONTENT_DEFAULTS['overlay_carrier_station_market'])

    def test_manager_saves_option_and_repaints_existing_window_immediately(self):
        env={"CONTENT_OPTIONS":CONTENT_OPTIONS,"option_key":option_key}
        exec(compile(source_method('overlay.py','OverlayManager','set_content_option'),'<content-option>','exec'),env)
        overlay=mock.Mock()
        overlay._last_carrier_data=copy.deepcopy(CARGO)
        manager=SimpleNamespace(settings={},save_settings=mock.Mock(),carrier_overlay=overlay)
        for enabled in (False,True):
            env['set_content_option'](manager,'carrier','station_market',enabled)
            self.assertEqual(manager.settings['overlay_carrier_station_market'],enabled)
        self.assertEqual(manager.save_settings.call_count,2)
        self.assertEqual(overlay.update_carrier.call_count,2)
        overlay.update_carrier.assert_called_with(overlay._last_carrier_data)
        self.assertEqual(overlay.apply_data_options.call_count,2)

    def test_preference_survives_save_load_without_overwriting_other_config(self):
        tree=ast.parse((HERE.parent/'overlay.py').read_text(encoding='utf-8'))
        funcs=[n for n in tree.body if isinstance(n,ast.FunctionDef)
               and n.name in ('save_overlay_settings','load_overlay_settings')]
        env={"Path":Path,"DEFAULT_SETTINGS":dict(CONTENT_DEFAULTS),
             "migrate_overlay_settings":lambda merged,stored:merged,
             "LEGACY_OVERLAY_KEYS":(),"DEFAULT_BLOCK_POSITIONS":{},"BLOCK_OVERRIDE_SUFFIXES":()}
        exec(compile(ast.Module(body=funcs,type_ignores=[]),'<settings>','exec'),env)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'
            path.write_text(json.dumps({'unrelated':'keep'}))
            for enabled in (False,True):
                env['save_overlay_settings'](path,{'overlay_carrier_station_market':enabled})
                restored=env['load_overlay_settings'](path)
                self.assertEqual(restored['overlay_carrier_station_market'],enabled)
                self.assertEqual(restored['unrelated'],'keep')


class CarrierMarketWiringTests(unittest.TestCase):
    def test_real_app_data_builder_includes_station_availability_and_keeps_carrier_total(self):
        env={"route_summary":lambda *_:{"current":"Sol","next":"","visited":0,"total":0,"remaining":[]}}
        exec(compile(source_method('colonial_helper.py','ColonialHelperApp','_get_overlay_data'),'<overlay-data>','exec'),env)
        market=StationMarketAvailability();market.handle(DOCK);market.handle(MARKET,live=True)
        app=SimpleNamespace(
            overlay_manager=SimpleNamespace(game_state=lambda:SimpleNamespace(running=True,focused=True,process_name='Elite')),
            api=SimpleNamespace(is_connected=False,display_name='Pilot'),raven_api=SimpleNamespace(is_connected=False),
            edsm_api=SimpleNamespace(enabled=False),inara_api=SimpleNamespace(enabled=False),watcher_active=True,
            _exobiology_overlay_state=lambda:{},upload_page=SimpleNamespace(progress_text=lambda:''),
            route=SimpleNamespace(systems=[],get_next_system_info=lambda:{},get_system_hint=lambda:{}),
            ship=SimpleNamespace(state=SimpleNamespace(current_system='Sol'),get_state_dict=lambda:{}),
            _session_cargo_tons=0,_session_systems_visited=set(),_session_deliveries=0,
            _session_route_deliveries=0,_session_route_cargo_tons=0,_session_construction_cargo_tons=0,
            _carrier_need_info=lambda:({},'', ''),carrier=SimpleNamespace(get_state_dict=lambda *_,**__:copy.deepcopy(CARGO)),
            _station_commerce=SimpleNamespace(market_availability=market),_last_delivery_system='',
            foot_map=SimpleNamespace(poll=lambda _:None,state=lambda:{}),journal_path=Path('.'))
        data=env['_get_overlay_data'](app)['carrier']
        self.assertTrue(data['commodities'][0]['station_sells'])
        self.assertEqual(data['stored'],15)
        market.handle({"event":"Undocked"})
        self.assertFalse(env['_get_overlay_data'](app)['carrier']['commodities'][0]['station_sells'])


if __name__ == '__main__':
    unittest.main()
