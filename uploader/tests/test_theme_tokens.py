"""Theme tokens provide a safe seam for future premium-market ownership."""
import sys
import unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from theme_tokens import ThemeTokens, theme_tokens

class ThemeTokenTests(unittest.TestCase):
    def test_default_theme_is_stable(self):
        tokens=theme_tokens()
        self.assertEqual(tokens.accent,"#e57b28")
        self.assertEqual(tokens.background,"#1e2022")

    def test_unknown_unowned_market_theme_falls_back(self):
        self.assertEqual(theme_tokens("premium-nebula").accent,theme_tokens().accent)

    def test_owned_market_tokens_override_only_known_semantic_keys(self):
        tokens=theme_tokens("premium-nebula",{"premium-nebula":{"accent":"#00ffaa","surprise":"x"}})
        self.assertEqual(tokens.accent,"#00ffaa")
        self.assertFalse(hasattr(tokens,"surprise"))
        self.assertIsInstance(tokens,ThemeTokens)

if __name__=="__main__":unittest.main()
