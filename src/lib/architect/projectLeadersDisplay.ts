/** Localize commodity fields only, never pilot/site names, IDs or totals. */
import { localizedCommodityName } from '../commodityNames.ts';
import type { LeaderSlice, ProjectLeadersView } from './projectLeaders.ts';

export function localizeLeaderCommodities<T extends ProjectLeadersView>(view: T, locale: string, other: string): T {
  const label = (key: string, fallback: string) => key === '__other'
    ? other : localizedCommodityName(key, locale, fallback);
  const slices = (rows: LeaderSlice[]) => rows.map((row) => ({ ...row, label: label(row.key, row.label) }));
  return {
    ...view,
    commodities: view.commodities.map((row) => ({ ...row, label: label(row.key, row.label) })),
    pilots: view.pilots.map((pilot) => ({
      ...pilot,
      commodities: slices(pilot.commodities),
      breakdown: pilot.breakdown.map((line) => ({
        ...line, commodityLabel: label(line.commodity, line.commodityLabel),
      })),
    })),
    sites: view.sites.map((site) => ({ ...site, commodities: slices(site.commodities) })),
    carriers: view.carriers.map((carrier) => ({ ...carrier, commodities: slices(carrier.commodities) })),
  };
}
