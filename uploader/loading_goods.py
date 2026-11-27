"""Shared category palette and display-only ordering. No Qt/network dependency."""
import json
from pathlib import Path
from i18n import tr
from system_map import commodity_label

METADATA = json.loads(Path(__file__).with_name("loading_goods.json").read_text(encoding="utf-8"))
CATEGORIES = METADATA["categories"]
GOODS = METADATA["goods"]
ORDERS = {
    "recipe": "По списку стройматериалов",
    "category": "По категориям",
    "name": "По алфавиту",
    "quantity": "По количеству",
    "remaining": "По остатку",
}


def good_category(good):
    return GOODS.get(good, {}).get("category", "Other")


def category_name(category):
    return tr(CATEGORIES.get(category, {}).get("ru", category))


def project_goods(rows, order="recipe", category="", query=""):
    """Copy/filter rows; unknown remainder sorts before measured remainder."""
    query = str(query or "").strip().casefold()
    rows = [row for row in rows if
            (not category or good_category(row["commodity"]) == category) and
            (not query or query in f'{commodity_label(row["commodity"])} {row["name"]} {row["commodity"]}'.casefold())]
    def key(row):
        good = row["commodity"]
        name = (commodity_label(good).casefold(), good)
        if order == "category":
            return (list(CATEGORIES).index(good_category(good)), *name)
        if order == "quantity":
            return (-row["required"], *name)
        if order == "remaining":
            return (-(row["remaining"] if row["remaining"] is not None else float("inf")), *name)
        if order == "name":
            return name
        return (GOODS.get(good, {}).get("order", float("inf")), *name)
    return sorted(rows, key=key)

DISPLAY_DEFAULTS = {"loading_goods_order": "recipe", "loading_goods_category": ""}


def display_options(settings):
    """Shared value-based selectors for HUD and Helper settings (no bool casts)."""
    return (
        ("loading_goods_order", tr("Группировка и порядок"), [(k, tr(v)) for k, v in ORDERS.items()], settings.get("loading_goods_order", "recipe")),
        ("loading_goods_category", tr("Категория"), [("", tr("Все категории"))] + [(k, category_name(k)) for k in CATEGORIES], settings.get("loading_goods_category", "")),
    )


def valid_display_option(key, value):
    return (key == "loading_goods_order" and value in ORDERS or
            key == "loading_goods_category" and (value == "" or value in CATEGORIES))
