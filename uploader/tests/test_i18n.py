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

#: Уже переведённые части Helper: страница «Подключение» и её обработчики.
AUTH_PAGE_CLASSES = ("AuthPageState", "AuthPage")
PILOT_PAGE_CLASSES = ("PilotPage",)
UPLOAD_PAGE_CLASSES = ("UploadPage",)
#: Метки внутри пришедшего текста ошибки, по которым выбирается цвет строки.
#: Это не подпись для пользователя, а разбор ответа сервера — они не переводятся.
ERROR_MARKER_LITERALS = {"ошиб", "невер", "недоступ", "сбой", "не удалось", "занят"}

AUTH_HELPER_FUNCTIONS = ("_build_tab_auth", "_save_edsm_settings", "_save_inara_settings",
                         "_capi_refresh_status", "_capi_fetch_and_upload", "_change_site_url",
                         "_on_validate_token", "_apply_token_result", "set_connection_status",
                         "_on_check_raven", "_check_raven_key_async")

#: Уже переведённые части инфографики пилота.
PILOT_HELPER_FUNCTIONS = ("_refresh_pilot_infographic", "_pilot_journal_state")


def placeholders(text: str) -> set:
    return set(PLACEHOLDER.findall(str(text)))


def _log_literal_ids(node) -> set:
    """Строки, ушедшие в ``self.log(...)``: это диагностика, не интерфейс."""
    found = set()
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        name = getattr(sub.func, "attr", None) or getattr(sub.func, "id", None)
        if name != "log":
            continue
        for argument in sub.args:
            for inner in ast.walk(argument):
                if isinstance(inner, ast.Constant):
                    found.add(id(inner))
    return found


def slice_literals(path: Path, *, classes=(), functions=()) -> list:
    """Русские литералы выбранных классов и функций (без докстрингов и логов)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    nodes = [node for node in ast.walk(tree)
             if isinstance(node, (ast.ClassDef, ast.FunctionDef))
             and (node.name in classes or (isinstance(node, ast.FunctionDef)
                                           and node.name in functions))]
    collected = []
    for node in nodes:
        docstrings = set()
        for inner in ast.walk(node):
            if isinstance(inner, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                text = ast.get_docstring(inner, clean=False)
                if text:
                    docstrings.add(text)
            if isinstance(inner, (ast.Module,)):
                pass
        skip = _log_literal_ids(node)
        for inner in ast.walk(node):
            if not isinstance(inner, ast.Constant) or not isinstance(inner.value, str):
                continue
            if inner.value in docstrings or id(inner) in skip:
                continue
            if CYRILLIC.search(inner.value):
                collected.append((inner.lineno, inner.value))
    return collected


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

    def test_connection_page_strings_are_in_the_catalog(self):
        missing = [f"helper_pages.py:{line}: {text!r}"
                   for line, text in slice_literals(UPLOADER / "helper_pages.py",
                                                    classes=AUTH_PAGE_CLASSES)
                   if text not in i18n_catalogs._STRINGS]
        self.assertEqual(missing, [], "страница «Подключение»: " + "; ".join(missing))

    def test_connection_handlers_strings_are_in_the_catalog(self):
        missing = [f"colonial_helper.py:{line}: {text!r}"
                   for line, text in slice_literals(UPLOADER / "colonial_helper.py",
                                                    functions=AUTH_HELPER_FUNCTIONS)
                   if text not in i18n_catalogs._STRINGS
                   and text not in ERROR_MARKER_LITERALS]
        self.assertEqual(missing, [], "обработчики «Подключения»: " + "; ".join(missing))

    def test_pilot_page_strings_are_in_the_catalog(self):
        missing = [f"helper_pages.py:{line}: {text!r}"
                   for line, text in slice_literals(UPLOADER / "helper_pages.py",
                                                    classes=PILOT_PAGE_CLASSES)
                   if text not in i18n_catalogs._STRINGS]
        self.assertEqual(missing, [], "страница «Пилот»: " + "; ".join(missing))

    def test_pilot_values_are_in_the_catalog(self):
        missing = [f"colonial_helper.py:{line}: {text!r}"
                   for line, text in slice_literals(UPLOADER / "colonial_helper.py",
                                                    functions=PILOT_HELPER_FUNCTIONS)
                   if text not in i18n_catalogs._STRINGS]
        self.assertEqual(missing, [], "значения инфографики: " + "; ".join(missing))

    def test_upload_page_strings_are_in_the_catalog(self):
        missing = [f"helper_pages.py:{line}: {text!r}"
                   for line, text in slice_literals(UPLOADER / "helper_pages.py",
                                                    classes=UPLOAD_PAGE_CLASSES)
                   if text not in i18n_catalogs._STRINGS]
        self.assertEqual(missing, [], "страница «Загрузка логов»: " + "; ".join(missing))

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
