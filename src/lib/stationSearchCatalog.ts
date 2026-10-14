import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleSymbol, parseSymbol, shipFdName, shipCoriolisId } from '@/lib/outfitting/fdnames';
import { groupName } from '@/lib/outfitting/i18n';
import type { OutfittingData } from '@/lib/outfitting/types';
import { searchKey, serviceAliases, type StationSearchKind, type StationSearchResult } from '@/lib/stationSearch';

let catalog: OutfittingData | undefined;
function data() {
  if (!catalog) catalog = JSON.parse(readFileSync(join(process.cwd(), 'public/data/outfitting.json'), 'utf8')) as OutfittingData;
  return catalog;
}
/** Translate display/group names to Frontier symbols without inventing station availability. */
export function stationQueryAliases(kind: StationSearchKind, query: string): string[] {
  if (kind === 'services') return serviceAliases(query);
  const aliases = new Set([query]);
  if (kind === 'market') return [...aliases];
  const key = searchKey(query);
  const d = data();
  if (kind === 'outfitting') {
    for (const [group, modules] of Object.entries(d.modules)) {
      for (const module of modules) {
        const descriptions = [module.name || '', groupName('ru', group), groupName('en', group)];
        if (!descriptions.some((description) => searchKey(description).includes(key))) continue;
        const symbol = moduleSymbol(module);
        if (symbol) aliases.add(/_(fast|strong)$/i.test(symbol) ? symbol : symbol.replace(/_size\d+_class\d+/i, ''));
        if (module.name) aliases.add(module.name);
      }
    }
  } else {
    for (const [id, ship] of Object.entries(d.ships)) {
      if ([id, ship.properties.name].some((name) => searchKey(name).includes(key))) {
        aliases.add(shipFdName(id)); aliases.add(ship.properties.name);
      }
    }
  }
  return [...aliases].slice(0, 100);
}
export function stationItemLabel(kind: StationSearchKind, item: StationSearchResult['item']): string {
  if (kind === 'outfitting') {
    const parsed = parseSymbol(item.symbol || item.name);
    if (parsed) return `${parsed.class}${parsed.rating} ${groupName('ru', parsed.group)}`;
    return `${item.class ?? ''}${item.rating ?? ''} ${item.name}`.trim();
  }
  if (kind === 'shipyard') {
    const ship = data().ships[shipCoriolisId(item.symbol || item.name)];
    return ship?.properties.name || item.name;
  }
  return item.name;
}
