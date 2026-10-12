/**
 * Разбор числового параметра поиска кольца, введённого с клавиатуры.
 *
 * Пробелы-разделители тысяч и запятая как десятичный знак допустимы (пользователи
 * пишут «23 000» и «23000»). Значение округляется до целого и зажимается в
 * допустимый диапазон: вне диапазона поле показывает ближайшую границу, а не
 * отказывается от ввода. Пустая или нечисловая строка → null (поле откатывается).
 */
export function parseRingParam(raw: string | number | null | undefined, min: number, max: number): number | null {
  const cleaned = String(raw ?? '')
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}
