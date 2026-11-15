/**
 * Внутренние имена Frontier ↔ модули справочника.
 *
 * Игра пишет в журнал (`Loadout.Modules[].Item`) имя вроде
 * `Int_LargeCargoRack_Size6_Class1` или `Hpt_MiningToolV2_Fixed_Large`, и это
 * единственное надёжное опознание модуля: класс, рейтинг и группу из него
 * можно вывести не всегда (Mk II модули, награды за общественные цели,
 * многофункциональные контроллеры дронов, новые предметы после обновления).
 * Поэтому справочник хранит символ у каждого модуля, а здесь строится
 * обратный индекс «символ → модуль».
 *
 * Индекс считается один раз на объект справочника: он живёт столько же,
 * сколько загруженный `outfitting.json`.
 */

import type { OutfittingData, OutfittingModule } from './types';

export interface SymbolMatch {
  group: string;
  module: OutfittingModule;
}

/** Символ без обёртки журнала (`$hpt_…_name;`) и в нижнем регистре. */
export function normalizeSymbol(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/^\$/, '').replace(/_name;?$/i, '').toLowerCase();
}

const CACHE = new WeakMap<OutfittingData, Map<string, SymbolMatch[]>>();

/**
 * Индекс «символ Frontier → модули» по всему справочнику.
 *
 * Один символ может принадлежать нескольким записям: заводские варианты
 * (`FSD V1`) и MercGear называются так же, как их базовый модуль — в игре это
 * тот же предмет с готовой инженерией внутри. Поэтому значений всегда список,
 * а выбор делает `moduleBySymbol`.
 */
export function symbolIndex(data: OutfittingData): Map<string, SymbolMatch[]> {
  const cached = CACHE.get(data);
  if (cached) return cached;
  const index = new Map<string, SymbolMatch[]>();
  for (const [group, list] of Object.entries(data.modules)) {
    for (const module of list) {
      if (!module.symbol) continue;
      // Заглушки набора Coriolis (`mm`, `mh`) и неизвестные рейтинги — не модули.
      if (module.rating === 'Z' || module.info) continue;
      const key = normalizeSymbol(module.symbol);
      if (!key) continue;
      const existing = index.get(key);
      if (existing) existing.push({ group, module });
      else index.set(key, [{ group, module }]);
    }
  }
  CACHE.set(data, index);
  return index;
}

/** Все записи справочника с таким внутренним именем Frontier. */
export function modulesBySymbol(data: OutfittingData, raw: string | null | undefined): SymbolMatch[] {
  const key = normalizeSymbol(raw);
  if (!key) return [];
  return symbolIndex(data).get(key) ?? [];
}

/**
 * Модуль по внутреннему имени Frontier из журнала или SLEF.
 *
 * При совпадении символа у нескольких записей берём обычный модуль: журнал
 * описывает инженерию полем `Engineering`, а не «заводской» вариант записи.
 * Если обычных записей несколько, честно возвращаем `null` — пусть разбор
 * идёт прежним путём и скажет, что модуль неоднозначен.
 */
export function moduleBySymbol(data: OutfittingData, raw: string | null | undefined): SymbolMatch | null {
  const matches = modulesBySymbol(data, raw);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const plain = matches.filter((match) => !match.module.preEngineered && !match.module.merc);
  return plain.length === 1 ? plain[0] : null;
}
