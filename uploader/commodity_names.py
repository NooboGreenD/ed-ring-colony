"""Display-only commodity localization, shared with the website (no Qt/network).

Game/API keys and stored journal-localized names must remain unchanged. Resolve
known names in the selected UI language, not the language of an old journal.
"""
import json
import re
from pathlib import Path

from i18n import current_locale

CATALOG = json.loads(Path(__file__).with_suffix('.json').read_text(encoding='utf-8'))
GOODS = CATALOG['goods']


def _fold(value):
    name = re.sub(r'_name;?$', '', str(value or '').strip().lstrip('$'), flags=re.I)
    return ''.join(ch for ch in name.lower().replace('ё', 'е') if ch.isalnum())


_ALIASES = {}
for _key, _names in GOODS.items():
    _ALIASES[_fold(_key)] = _key
    for _name in _names.values():
        _ALIASES.setdefault(_fold(_name), _key)
for _alias, _key in CATALOG['aliases'].items():
    _ALIASES[_fold(_alias)] = _key


def known_commodity_key(value):
    return _ALIASES.get(_fold(value))


def commodity_label(value, fallback=None, *, locale=None):
    """Known good → UI name; unknown good → original label, never an empty key."""
    original = str(value or '').strip()
    fallback = str(fallback or original)
    key = known_commodity_key(original) or known_commodity_key(fallback)
    if key is None:
        return fallback
    names = GOODS[key]
    language = str(locale or current_locale()).split('-')[0].lower()
    # Do not replace a real Russian journal label with English when a newly
    # added commodity has no verified Russian entry in the bundled source.
    if language == 'ru' and not names.get('ru') and re.search('[А-Яа-яЁё]', fallback):
        return fallback
    return names.get(language) or names.get('en') or fallback
