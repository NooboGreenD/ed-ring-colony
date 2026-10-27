"""Regressions for replacing the system-map view with faction infographics."""
from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
import colonial_helper
from system_map import MapSnapshot


class FactionWorkspaceTests(unittest.TestCase):
    def test_navigation_registers_factions_instead_of_system_map(self):
        source=inspect.getsource(colonial_helper.ColonialHelperApp._build_notebook)
        self.assertIn('text="Фракции"',source)
        self.assertNotIn('text="Карта системы"',source)
        self.assertIn('self.tab_map = None',source)

    def test_old_map_entrypoint_redirects_to_factions_without_rendering(self):
        app=SimpleNamespace(
            _map_last_snapshot=MapSnapshot(system="Sol"),
            system_map=SimpleNamespace(snapshot=lambda:MapSnapshot(system="Sol")),
            _map_selected="",_map_center="",_map_zoom_index=2,
            MAP_ZOOM_STEPS=(0.5,0.75,1.0,1.5),
            map_view_mode=mock.Mock(),config={},notebook=mock.Mock(),
            tab_factions="factions",log=mock.Mock(),_map_redraw_now=mock.Mock(),
        )
        colonial_helper.ColonialHelperApp._on_map_open_3d(app,"Earth")
        app.notebook.select.assert_called_once_with("factions")
        app._map_redraw_now.assert_not_called()
        app.log.assert_called_once()

    def test_journal_snapshot_drives_local_faction_presence_and_influence(self):
        app=SimpleNamespace(_faction_state_lock=__import__("threading").RLock(),
            _faction_updated_at="",_faction_system="",_faction_controlling="",
            _faction_presence=[],after=mock.Mock())
        event={"event":"FSDJump","timestamp":"2026-10-27T12:00:00Z","StarSystem":"Sol",
               "SystemFaction":{"Name":"Sol Workers' Party"},"Factions":[
                   {"Name":"Low Influence","Influence":0.12,"Government":"Democracy"},
                   {"Name":"Sol Workers' Party","Influence":0.58,"Allegiance":"Federation","ActiveStates":[{"State":"Boom"}]}]}
        colonial_helper.ColonialHelperApp._update_faction_infographic(app,event)
        self.assertEqual(app._faction_system,"Sol")
        self.assertEqual(app._faction_controlling,"Sol Workers' Party")
        self.assertEqual(app._faction_presence[0]["name"],"Sol Workers' Party")
        self.assertEqual(app._faction_presence[0]["influence"],0.58)
        app.after.assert_not_called()

    def test_faction_links_carry_the_selected_site_locale(self):
        from locale_config import localized_url
        self.assertEqual(localized_url("https://edringcolony.ru/atlas?tab=factions","de"),
                         "https://edringcolony.ru/atlas?tab=factions&locale=de")


if __name__=="__main__":
    unittest.main()
