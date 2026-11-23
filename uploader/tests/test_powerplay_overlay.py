"""Real Qt PowerPlay HUD and standard per-block preferences (offscreen)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
try:
    from PySide6.QtWidgets import QLabel
    from overlay import (PowerplayOverlay, OverlayManager, DEFAULT_SETTINGS,
                         load_overlay_settings, save_overlay_settings)
    from overlay_layout import BLOCK_LABELS, DEFAULT_BLOCK_POSITIONS
    from hud_window import OVERLAY_META
    from overlay_options import CONTENT_OPTIONS
    from test_powerplay_page import commander_state, system_state
    from ui_qt import ensure_app
    QT_ERROR = None
except (ImportError, OSError) as exc:
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f'Qt runtime unavailable: {QT_ERROR}')
class PowerplayOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.settings = dict(DEFAULT_SETTINGS)
        self.overlay = PowerplayOverlay(None, self.settings)
        self.addCleanup(self.overlay.destroy)

    def test_registered_in_all_standard_block_management_tables(self):
        for collection in (OverlayManager.BLOCKS, BLOCK_LABELS, DEFAULT_BLOCK_POSITIONS,
                           OVERLAY_META, CONTENT_OPTIONS):
            self.assertIn('powerplay', collection)
        self.assertFalse(DEFAULT_SETTINGS['show_powerplay'])

    def test_same_information_as_tab_including_live_merits_rank_and_balance(self):
        state = commander_state(system=system_state())
        self.overlay.update_powerplay(state)
        panel = self.overlay.panel
        self.assertIn('4 320', panel.rank_label.text())
        self.assertIn('Sol', panel.system_label.text())
        self.assertEqual(panel.balance_bar.reinforcement, 1240)
        self.assertTrue(panel.action_lines())
        self.assertEqual(panel.state(), state)
        self.assertEqual(panel.control_bar.value(), 620)

    def test_sections_can_hide_and_restore_without_new_data(self):
        state = commander_state(system=system_state())
        self.overlay.update_powerplay(state)
        for section, widget in [('commander', self.overlay.panel.commander_card),
                                ('system', self.overlay.panel.system_card),
                                ('actions', self.overlay.panel.actions_widget),
                                ('source', self.overlay.panel.source_label)]:
            key = f'overlay_powerplay_{section}'
            self.settings[key] = False
            self.overlay.apply_data_options()
            self.assertTrue(widget.isHidden(), section)
            self.settings[key] = True
            self.overlay.apply_data_options()
            self.assertFalse(widget.isHidden(), section)
        self.assertEqual(self.overlay.panel.state(), state)

    def test_empty_state_never_forces_data_cards_visible(self):
        self.overlay.update_powerplay({})
        self.overlay.apply_data_options()
        self.assertTrue(self.overlay.panel.commander_card.isHidden())
        self.assertTrue(self.overlay.panel.system_card.isHidden())
        self.assertTrue(self.overlay.panel.actions_widget.isHidden())

    def test_font_applies_to_existing_and_new_action_labels(self):
        self.overlay.apply_font('Arial', 17)
        self.overlay.update_powerplay(commander_state())
        for widget in self.overlay.panel.findChildren(QLabel):
            self.assertEqual(widget.font().family(), 'Arial')

    def test_standard_preferences_survive_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'config.json'
            settings = dict(DEFAULT_SETTINGS, powerplay_alpha=0.65, powerplay_font_size=15,
                            powerplay_hotkey='Ctrl+F9', powerplay_locked=True,
                            powerplay_detached=True, powerplay_anchor='top_right',
                            powerplay_auto_rule='game_focused', show_powerplay=True,
                            overlay_powerplay_actions=False)
            save_overlay_settings(path, settings)
            restored = load_overlay_settings(path)
            for key in settings:
                if 'powerplay' in key:
                    self.assertEqual(restored[key], settings[key], key)


if __name__ == '__main__':
    unittest.main()
