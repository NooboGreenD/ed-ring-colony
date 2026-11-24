"""Product icons for source runs, versioned code bundles and frozen Setup.

Paths never depend on the caller's working directory. Qt is imported lazily
so bundle construction and resource tests do not require a desktop runtime.
"""
from pathlib import Path
import sys

ICON_ASSETS = (
    'colonial_helper.ico',
    'colonial_helper.png',
    'colonial_helper_tray.ico',
    'colonial_helper_tray.png',
)


def icon_resource(name: str) -> Path | None:
    path = Path(name)
    if path.is_absolute():
        return path if path.is_file() else None
    # Updated app bundle takes precedence over the older embedded copy.
    roots = [Path(__file__).resolve().parent]
    frozen = getattr(sys, '_MEIPASS', None)
    if frozen:
        roots.extend((Path(frozen), Path(frozen) / 'app_bundle'))
    return next((root / path for root in roots if (root / path).is_file()), None)


def _load(names):
    from PySide6.QtGui import QIcon
    for name in names:
        path = icon_resource(name)
        if path:
            icon = QIcon(str(path))
            if not icon.isNull():
                return icon
    return QIcon()


def application_icon():
    """Multi-resolution app/Alt+Tab icon, with a PNG decoder fallback."""
    return _load(('colonial_helper.ico', 'colonial_helper.png'))


def tray_icon():
    """Dedicated optical redraw; never shrink detailed artwork to 16px."""
    icon = _load(('colonial_helper_tray.ico', 'colonial_helper_tray.png'))
    return application_icon() if icon.isNull() else icon
