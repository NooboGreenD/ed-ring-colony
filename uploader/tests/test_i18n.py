"""Проверки локализации интерфейса.

Ключ перевода — русская строка из кода, поэтому проверять нужно три вещи:
перевод есть во всех языках проекта, подстановки в переводе те же, что в
оригинале, и ни одна русская строка в переведённых модулях не осталась вне
каталога. Последнее ловит опечатку в ключе: строка с ошибкой просто не найдёт
перевода и молча останется русской.
"""
import ast
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPLOADER = HERE.parent
sys.path.insert(0, str(UPLOADER))

import i18n  # noqa: E402
import i18n_catalogs  # noqa: E402
from locale_config import DEFAULT_LOCALE, SUPPORTED_LOCALES  # noqa: E402

CYRILLIC = re.compile("[А-Яа-яЁё]")
PLACEHOLDER = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")

#: Модули, у которых весь пользовательский текст уже идёт через ``tr()``.
TRANSLATED_MODULES = ("launcher_window.py", "installer_window.py",
                      "helper_shell.py", "ui_qt.py")


def placeholders(text: str) -> set:
    return set(PLACEHOLDER.findall(str(text)))


def russian_literals(path: Path) -> list:
    """Все русские строковые литералы файла, кроме докстрингов."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            text = ast.get_docstring(node, clean=False)
            if text:
                docstrings.add(text)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in docstrings or not CYRILLIC.search(node.value):
                continue
            found.append((node.lineno, node.value))
    return found


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.saved = i18n.current_locale()

    def tearDown(self):
        i18n.set_locale(self.saved)

    def test_every_project_language_has_every_key(self):
        sources = set(i18n_catalogs._STRINGS)
        self.assertTrue(sources)
        for code in SUPPORTED_LOCALES:
            if code == DEFAULT_LOCALE:
                continue
            catalog = i18n_catalogs.CATALOGS.get(code) or {}
            self.assertEqual(set(catalog), sources, f"язык {code}: набор ключей разошёлся")
            for key, value in catalog.items():
                self.assertTrue(str(value).strip(), f"язык {code}: пустой перевод {key!r}")

    def test_russian_catalog_is_the_source_itself(self):
        i18n.set_locale("ru")
        self.assertEqual(i18n.catalog(), {})

    def test_placeholders_match_between_source_and_translation(self):
        for key, translations in i18n_catalogs._STRINGS.items():
            expected = placeholders(key)
            for code, value in translations.items():
                self.assertEqual(placeholders(value), expected,
                                 f"{code}: подстановки не совпадают с оригиналом {key!r}")

    def test_every_russian_literal_in_translated_modules_is_a_key(self):
        missing = []
        for name in TRANSLATED_MODULES:
            for lineno, text in russian_literals(UPLOADER / name):
                if text not in i18n_catalogs._STRINGS:
                    missing.append(f"{name}:{lineno}: {text!r}")
        self.assertEqual(missing, [], "строки без записи в каталоге: " + "; ".join(missing))

    def test_translations_differ_from_the_source(self):
        for key, translations in i18n_catalogs._STRINGS.items():
            for code, value in translations.items():
                self.assertNotEqual(str(value), key, f"{code}: строка не переведена — {key!r}")


class TranslationTests(unittest.TestCase):
    def setUp(self):
        self.saved = i18n.current_locale()

    def tearDown(self):
        i18n.set_locale(self.saved)

    def test_unknown_locale_falls_back_to_russian(self):
        i18n.set_locale("xx")
        self.assertEqual(i18n.current_locale(), DEFAULT_LOCALE)
        self.assertEqual(i18n.tr("УПРАВЛЕНИЕ"), "УПРАВЛЕНИЕ")

    def test_locale_codes_are_normalised(self):
        self.assertEqual(i18n.set_locale("EN-us"), "en")
        self.assertEqual(i18n.set_locale(" DE "), "de")
        self.assertEqual(i18n.set_locale(None), DEFAULT_LOCALE)

    def test_translated_string_is_returned_for_known_key(self):
        i18n.set_locale("en")
        self.assertEqual(i18n.tr("УПРАВЛЕНИЕ"), "CONTROL")
        self.assertTrue(i18n.is_translated("УПРАВЛЕНИЕ"))
        self.assertFalse(i18n.is_translated("Строка, которой нет в каталоге"))

    def test_unknown_string_is_returned_as_is(self):
        i18n.set_locale("de")
        self.assertEqual(i18n.tr("Текст без перевода"), "Текст без перевода")

    def test_placeholders_are_filled(self):
        i18n.set_locale("en")
        self.assertEqual(i18n.tr("Установить v{version}", version="2.0.0"), "Install v2.0.0")
        self.assertEqual(i18n.tr("Канал обновлений: {channel}", channel="beta"),
                         "Update channel: beta")

    def test_missing_placeholder_does_not_raise(self):
        i18n.set_locale("en")
        # Аргумента нет — окно не должно падать из-за подписи.
        self.assertEqual(i18n.tr("Установить v{version}"), "Install v{version}")

    def test_available_lists_every_project_language(self):
        self.assertEqual(list(i18n.available()), list(SUPPORTED_LOCALES))
        for code, name in i18n.available().items():
            self.assertIn(code, SUPPORTED_LOCALES)
            self.assertTrue(str(name).strip())


if __name__ == "__main__":
    unittest.main()
