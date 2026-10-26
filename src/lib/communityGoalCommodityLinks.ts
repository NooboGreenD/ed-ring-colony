import items from './stationSearchItems.json' with { type: 'json' };

function commodityKey(value: string): string {
  return value.normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export interface CommunityGoalObjectivePart {
  text: string;
  commodity: string | null;
}

type CommodityRecord = { name: string };
const commodityNames = Array.from(new Set(
  [...(items.commodities as CommodityRecord[]), ...(items.rare as CommodityRecord[])]
    .map((commodity) => commodity.name.trim())
    .filter(Boolean),
)).sort((left, right) => right.length - left.length || left.localeCompare(right));

const canonicalByKey = new Map(commodityNames.map((name) => [commodityKey(name), name]));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const commodityPattern = commodityNames.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(${commodityNames.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  : null;

/** Split an objective into plain text and exact, game-named commodity matches. */
export function splitCommunityGoalObjective(text: string): CommunityGoalObjectivePart[] {
  if (!text || !commodityPattern) return text ? [{ text, commodity: null }] : [];

  const matcher = new RegExp(commodityPattern.source, commodityPattern.flags);
  const parts: CommunityGoalObjectivePart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), commodity: null });
    const matchedText = match[0];
    parts.push({ text: matchedText, commodity: canonicalByKey.get(commodityKey(matchedText)) ?? matchedText });
    cursor = match.index + matchedText.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), commodity: null });
  return parts.length ? parts : [{ text, commodity: null }];
}
