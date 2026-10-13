import blueprints from './constructionBlueprints.json';

/** Community-observed baseline cargo, not a live depot's remaining requirements.
 * Factual data source: RavenColonialWeb/src/assets/colonization-costs2.json
 * https://github.com/njthomson/RavenColonialWeb (retrieved 2026-10-13).
 * Display names checked against https://github.com/EDCD/FDevIDs/blob/master/commodity.csv.
 * Economy/layout/game updates can change quantities: the in-game depot is authoritative.
 */
export const CONSTRUCTION_BLUEPRINTS = blueprints;
export const CONSTRUCTION_COMMODITIES = Array.from(
  new Set(
    blueprints.flatMap((site) =>
      site.materials.map((material) => material.name)
    )
  )
).sort();
export function constructionBlueprint(id: string) {
  return blueprints.find((site) => site.id === id);
}
export function constructionCommodities(id = 'all'): string[] {
  return id === 'all'
    ? CONSTRUCTION_COMMODITIES
    : (constructionBlueprint(id)?.materials.map((material) => material.name) ??
        []);
}
