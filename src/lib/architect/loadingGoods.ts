/** Display-only metadata shared with the packaged Helper HUD. */
import metadata from "../../../uploader/loading_goods.json" with { type: "json" };
export const loadingCategories: Record<string, { ru: string; color: string }> =
  metadata.categories;
const goods: Record<string, { category: string; order: number }> =
  metadata.goods;
export type LoadingGoodsOrder =
  | "recipe"
  | "category"
  | "name"
  | "quantity"
  | "remaining";
export function loadingGoodCategory(good: string): string {
  return goods[good]?.category ?? "Other";
}
export function loadingCategoryName(category: string, locale: string): string {
  return locale === "ru"
    ? (loadingCategories[category]?.ru ?? category)
    : category;
}
export function loadingGoodColor(good: string): string {
  return loadingCategories[loadingGoodCategory(good)]?.color ?? "#acb4bf";
}
export function orderLoadingGoods<
  T extends { commodity: string; required: number; remaining?: number | null },
>(
  rows: T[],
  order: LoadingGoodsOrder,
  label: (good: string) => string,
  locale = "en",
): T[] {
  const byName = (a: T, b: T) =>
    label(a.commodity).localeCompare(label(b.commodity), locale) ||
    a.commodity.localeCompare(b.commodity);
  const categories = Object.keys(loadingCategories);
  return [...rows].sort((a, b) => {
    if (order === "category")
      return (
        categories.indexOf(loadingGoodCategory(a.commodity)) -
          categories.indexOf(loadingGoodCategory(b.commodity)) || byName(a, b)
      );
    if (order === "quantity") return b.required - a.required || byName(a, b);
    // Unknown is not zero: show it ahead of measured remaining demand.
    if (order === "remaining")
      return (
        (b.remaining ?? Infinity) - (a.remaining ?? Infinity) || byName(a, b)
      );
    if (order === "recipe")
      return (
        (goods[a.commodity]?.order ?? Infinity) -
          (goods[b.commodity]?.order ?? Infinity) || byName(a, b)
      );
    return byName(a, b);
  });
}
