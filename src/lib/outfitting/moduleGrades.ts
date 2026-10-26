/**
 * Класс и рейтинг модуля по игровому символу — из снимка EDCD/FDevIDs
 * (`stationSearchItems.json`, outfitting.csv).
 *
 * В символе внутреннего модуля рейтинг закодирован (`_Class5` — это A), а в
 * символе орудия — нет: `Hpt_PulseLaser_Gimbal_Small` это 1G, а
 * `parseSymbol` знает только размер и ставит заглушку E. Поэтому снимки
 * станций (EDDN, Helper, EDSM) берут класс и рейтинг отсюда, а разбор
 * символа остаётся запасным путём для модулей, которых в снимке нет.
 */
import items from '../stationSearchItems.json' with { type: 'json' };

export interface ModuleGrade {
  class: number;
  rating: string;
}

type ModuleItem = [symbol: string, size: number, rating: string, mount: string];
type ModuleCatalogEntry = { name: string; items: ModuleItem[] };

let grades: Map<string, ModuleGrade> | undefined;
let names: Map<string, string | null> | undefined;

/** Каталожная подпись Frontier для точного различения вариантов одного класса. */
export function moduleNameForSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  if (!names) {
    names = new Map();
    for (const module of items.modules as unknown as ModuleCatalogEntry[]) {
      for (const [itemSymbol] of module.items) {
        const key = moduleSymbolKey(itemSymbol);
        const previous = names.get(key);
        names.set(key, previous === undefined || previous === module.name ? module.name : null);
      }
    }
  }
  return names.get(moduleSymbolKey(symbol)) ?? null;
}

/** Символ без обёртки журнала/CAPI (`$hpt_…_name;`) в нижнем регистре. */
export function moduleSymbolKey(symbol: string): string {
  return symbol.trim().replace(/^\$/, '').replace(/_name;?$/i, '').toLowerCase();
}

export function moduleGrade(symbol: string | null | undefined): ModuleGrade | null {
  if (!symbol) return null;
  if (!grades) {
    grades = new Map();
    for (const module of items.modules as Array<{ name: string; category: string; items: ModuleItem[] }>) {
      for (const [itemSymbol, size, rating] of module.items) grades.set(itemSymbol.toLowerCase(), { class: size, rating });
    }
  }
  return grades.get(moduleSymbolKey(symbol)) ?? null;
}
