/**
 * Происхождение модуля — цвет и значок в списках верфи.
 *
 * В игре три вида техники красятся по-разному, и это единственная быстрая
 * подсказка, «чем» модуль является:
 *
 *  * Merc Coin — награда за операции, жетоны (цвет жетонов — тёплый,
 *    янтарный);
 *  * Стражи (Guardian) — технологии древней расы: холодный циан;
 *  * AX — анти-ксено техника Таргоидов: зелёный.
 *
 * Английские названия групп совпадают с ключами `public/data/outfitting.json`,
 * поэтому список групп — это часть справочника, а не перевода: он не меняется
 * от языка интерфейса.
 */

import type { OutfittingModule } from './types';
import { mercEntryFor } from './merccoin';

export type ModuleOrigin = 'merc' | 'guardian' | 'ax';

/** Цвета значка и подсветки строки. */
export const ORIGIN_COLORS: Record<ModuleOrigin, string> = {
  // Жетоны Merc Coin: тёплое золото, как на иконке валюты.
  merc: '#fbbf24',
  // Технологии Стражей: холодный циан их кристаллов и маяков.
  guardian: '#22d3ee',
  // Анти-ксено техника: зелёный Таргоидов.
  ax: '#4ade80',
};

const GUARDIAN_GROUPS = new Set([
  'ggc', 'gpc', 'gsc', // орудия Стражей
  'gsrp', 'gfsb', 'ghrp', 'gmrp', // усилители и бустеры Стражей
]);

const AX_GROUPS = new Set([
  'axmc', 'axmce', 'axmr', 'axmre', // анти-ксено орудия
  'tbsc', 'tbem', 'tbrfl', // техника Таргоидов
  'xs', 'sfn', 'ews', 'csl', // ксено-сканер, нейтрализаторы, каустический сброс
]);

/** Виды техники у модуля — их может быть несколько (например, AX + Страж). */
export function moduleOrigins(module: OutfittingModule | null): ModuleOrigin[] {
  if (!module) return [];
  const origins: ModuleOrigin[] = [];
  const name = module.name ?? '';
  if (module.merc === true || mercEntryFor(module.grp, module.id)) origins.push('merc');
  if (GUARDIAN_GROUPS.has(module.grp) || /^Guardian\b/i.test(name)) origins.push('guardian');
  if (AX_GROUPS.has(module.grp) || /^AX\b/i.test(name) || /Thargoid/i.test(name)) origins.push('ax');
  return origins;
}

/** Цвет первого (главного) происхождения — для полосок и значков. */
export function originColor(origins: ModuleOrigin[]): string | null {
  return origins.length ? ORIGIN_COLORS[origins[0]] : null;
}

/** Ключ подписи для языка интерфейса: `outfitting.origin.<вид>`. */
export function originLabelKey(origin: ModuleOrigin): string {
  return `outfitting.origin.${origin}`;
}
