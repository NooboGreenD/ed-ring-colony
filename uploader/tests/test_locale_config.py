"""Locale selection is normalized and shared by launcher, Helper and site links."""
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from locale_config import SUPPORTED_LOCALES, normalize_locale, localized_url
from api_client import ApiClient

class LocaleConfigTests(unittest.TestCase):
    def test_all_supported_site_locales_are_exposed(self):
        self.assertEqual(set(SUPPORTED_LOCALES),{"ru","en","de","it","ko","zh","ja"})

    def test_normalizes_region_tags_and_unknown_values(self):
        self.assertEqual(normalize_locale("de-DE"),"de")
        self.assertEqual(normalize_locale("ZH_cn"),"zh")
        self.assertEqual(normalize_locale("xx"),"ru")

    def test_localized_url_preserves_existing_query(self):
        self.assertEqual(localized_url("https://example.test/account?tab=tokens","it"),
                         "https://example.test/account?tab=tokens&locale=it")

    def test_api_client_sends_the_selected_accept_language(self):
        client=ApiClient(locale="ko")
        self.assertEqual(client._session.headers["Accept-Language"],"ko")
        client.set_locale("ja")
        self.assertEqual(client._session.headers["Accept-Language"],"ja")

if __name__=="__main__":unittest.main()
