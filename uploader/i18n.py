"""Локализация интерфейса Launcher, Setup и Helper.

Ключ перевода — русская строка-источник, как ``msgid`` в gettext. Так код
остаётся читаемым, не нужны отдельные таблицы «ключ → строка» и не бывает
ситуации «ключ есть, а строки нет». Отсутствующий перевод автоматически
падает назад на русский оригинал, поэтому недоперевод — это русский текст, а
не пустое место и не «launcher.run».

Язык один на все три окна: его выбирают в лаунчере, он лежит в общем
``~/.colonial_helper.json`` (``site_locale``) и оттуда же читается Setup и
Helper. Раньше ``site_locale`` влиял только на адреса сайта и на язык ленты
новостей — интерфейс оставался русским.

Подстановки задаются в самой строке: ``tr("Установить v{version}", version=...)``.
"""
from __future__ import annotations

from typing import Dict

from i18n_catalogs import CATALOGS
from locale_config import DEFAULT_LOCALE, SUPPORTED_LOCALES, normalize_locale

#: Текущий язык процесса. Меняется до построения окон и при смене в лаунчере.
_current = DEFAULT_LOCALE


def available() -> Dict[str, str]:
    """Коды и названия языков в порядке показа в списке."""
    return dict(SUPPORTED_LOCALES)


def current_locale() -> str:
    return _current


def set_locale(value: object) -> str:
    """Переключить язык процесса; неизвестный код сводится к русскому."""
    global _current
    _current = normalize_locale(value)
    return _current


def catalog(locale: object = None) -> Dict[str, str]:
    """Словарь выбранного языка (для проверок и сборки подсказок)."""
    return CATALOGS.get(normalize_locale(locale if locale is not None else _current), {})


def tr(text: str, **kwargs: object) -> str:
    """Перевести строку и подставить значения.

    Перевод ищется в текущем языке, затем в русском оригинале; если строки нет
    нигде — возвращается она сама. Ошибка в подстановке не должна ронять окно,
    поэтому ``format`` вызывается только когда есть аргументы.
    """
    source = str(text)
    template = catalog().get(source) or source
    if not kwargs:
        return template
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError, ValueError):
        return template


def is_translated(text: str) -> bool:
    """Есть ли у строки перевод на текущий язык (для проверок каталога)."""
    return str(text) in catalog()


__all__ = [
    "CATALOGS", "available", "catalog", "current_locale", "is_translated",
    "set_locale", "tr",
]
