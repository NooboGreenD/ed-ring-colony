"""Справочник типов построек Raven Colonial: что уходит в buildType.

Неизвестный код валит страницу проекта на сайте Raven (падение `buildClass`),
поэтому проверяем: справочник совпадает с каталогом «Архитектора», значения
из журнала и планов приводятся к кодам, а мусор не проходит.
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from colony_build_types import (  # noqa: E402
    BUILD_TYPE_CODES, BUILD_TYPES, build_type_label, normalize_build_type,
)

ROOT = Path(__file__).resolve().parents[2]


class BuildTypeCatalogueTests(unittest.TestCase):
    def test_codes_match_architect_catalogue(self):
        """Справочник uploader'а — копия каталога сайта: расхождений быть не должно."""
        source = (ROOT / "src/lib/architect/catalogue.ts").read_text(encoding="utf-8")
        block = source[source.index("const CATALOGUE_ENTRIES"):]
        site_codes = re.findall(r"\n  \{\n    id: '([^']+)',", block)
        self.assertEqual(sorted(site_codes), sorted(BUILD_TYPE_CODES))
        self.assertEqual(len(BUILD_TYPES), 55)

    def test_label_contains_code_and_name(self):
        self.assertEqual(build_type_label("zeus"), "Планетарный порт [zeus]")
        self.assertEqual(build_type_label("nope"), "nope")


class NormalizeBuildTypeTests(unittest.TestCase):
    def test_known_codes_pass_through(self):
        for code in ("no_truss", "apollo", "vulcan", "hestia", "janus"):
            self.assertEqual(normalize_build_type(code), code)

    def test_game_tokens_and_names_are_mapped(self):
        self.assertEqual(normalize_build_type("$Coriolis_Starport; (primary)"), "no_truss")
        self.assertEqual(normalize_build_type("Orbis Starport"), "apollo")
        self.assertEqual(normalize_build_type("Coriolis"), "no_truss")
        self.assertEqual(normalize_build_type("Ceres"), "ceres")
        self.assertEqual(normalize_build_type("Planetary Port"), None)  # неоднозначно для нас

    def test_unknown_values_are_rejected(self):
        for raw in ("", None, 42, "Что-то своё", "Coriolis Starport Mk9"):
            self.assertIsNone(normalize_build_type(raw), raw)


if __name__ == "__main__":
    unittest.main()
