export type AchievementRank = {
  rank: number;
  threshold: number;
  name: string;
  desc: string;
};

export type AchievementTrack = {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  icon: string;
  ranks: AchievementRank[];
  match: (commodity: string) => boolean;
};

export type TrackProgress = {
  earned: number;
  current: AchievementRank | null;
  next: AchievementRank | null;
  into: number;
  color: string;
  total: number;
};

function norm(commodity: string) {
  return String(commodity)
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/_name;$/, '')
    .replace(/[^a-zа-яё0-9]+/gi, '');
}

const isSteel = (c: string) => {
  const n = norm(c);
  return n === 'steel' || n === 'сталь' || n === 'стали' || n.endsWith('steel');
};

const isTitanium = (c: string) => {
  const n = norm(c);
  return n === 'titanium' || n.includes('титан');
};

const isCmm = (c: string) => {
  const n = norm(c);
  return n.includes('cmm') || n === 'cmmcomposite' || n === 'cmmкомпозит';
};

/* ── Tier colours (Inara-style, 10 tiers) ── */
const TIER_COLORS = [
  '#9ca3af',   // Tier 1 — grey
  '#67e8f9',   // Tier 2 — cyan
  '#3498db',   // Tier 3 — blue
  '#2ecc71',   // Tier 4 — green
  '#e67e22',   // Tier 5 — orange
  '#f39c12',   // Tier 6 — gold
  '#e74c3c',   // Tier 7 — red
  '#a855f7',   // Tier 8 — purple
  '#ec4899',   // Tier 9 — pink
  '#00d4ff',   // Tier 10 — diamond
];

const TIER_BG = [
  'rgba(148,163,184,0.08)',
  'rgba(103,232,249,0.08)',
  'rgba(52,152,219,0.08)',
  'rgba(46,204,113,0.08)',
  'rgba(230,126,34,0.08)',
  'rgba(243,156,18,0.08)',
  'rgba(231,76,60,0.08)',
  'rgba(168,85,247,0.08)',
  'rgba(236,72,153,0.08)',
  'rgba(0,212,255,0.08)',
];

const TIER_BORDER = [
  'rgba(148,163,184,0.35)',
  'rgba(103,232,249,0.35)',
  'rgba(52,152,219,0.35)',
  'rgba(46,204,113,0.35)',
  'rgba(230,126,34,0.35)',
  'rgba(243,156,18,0.35)',
  'rgba(231,76,60,0.35)',
  'rgba(168,85,247,0.35)',
  'rgba(236,72,153,0.35)',
  'rgba(0,212,255,0.35)',
];

/* ── Helpers ── */
function makeRanks(
  names: string[],
  thresholds: number[],
  label: string,
): AchievementRank[] {
  return names.map((name, i) => ({
    rank: i + 1,
    threshold: thresholds[i],
    name,
    desc: `${thresholds[i].toLocaleString('ru-RU')}+ ${label}`,
  }));
}

function makeCountRanks(
  names: string[],
  thresholds: number[],
  label: string,
): AchievementRank[] {
  return names.map((name, i) => ({
    rank: i + 1,
    threshold: thresholds[i],
    name,
    desc: `${thresholds[i].toLocaleString('ru-RU')}+ ${label}`,
  }));
}

/* ── Thresholds (10 tiers) ── */
const CARGO_TONS:    number[] = [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000];
const MAT_TONS:      number[] = [1_000, 5_000, 25_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
const HUB_COUNTS:    number[] = [5, 15, 30, 60, 100, 150, 250, 400, 600, 1_000];
const OPS_COUNTS:    number[] = [10, 50, 200, 500, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const ARCH_COUNTS:   number[] = [5, 20, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000];

/* ── Tracks ── */
export const ACHIEVEMENT_TRACKS: AchievementTrack[] = [
  {
    id: 'cargo',
    title: 'Экспедиционер',
    subtitle: 'Общий тоннаж доставок',
    color: '#e67e22',
    icon: '⚓',
    match: () => true,
    ranks: makeRanks(
      ['Космический курьер', 'Грузовой агент', 'Караванщик', 'Флотоводец', 'Легенда кольца',
       'Титан перевозок', 'Галактический логист', 'Повелитель грузопотоков', 'Квантовый капитан', 'Вечный экспедиционер'],
      CARGO_TONS,
      'т груза',
    ),
  },
  {
    id: 'steel',
    title: 'Металлург',
    subtitle: 'Завезено стали',
    color: '#eeeeee',
    icon: '⚙️',
    match: isSteel,
    ranks: makeRanks(
      ['Стальной след', 'Литейщик', 'Стальной хребет', 'Кузнец кольца', 'Владыка стали',
       'Стальной колосс', 'Плавильщик звёзд', 'Архимаг металла', 'Стальной бог', 'Вечный кузнец'],
      MAT_TONS,
      'т стали',
    ),
  },
  {
    id: 'titanium',
    title: 'Титановый мастер',
    subtitle: 'Завезено титана',
    color: '#7dd3fc',
    icon: '💎',
    match: isTitanium,
    ranks: makeRanks(
      ['Титановый след', 'Титановый каркас', 'Титановый щит', 'Титановая крепость', 'Титановый колосс',
       'Титановый левиафан', 'Кристаллизатор', 'Титановый архонт', 'Титановый бог', 'Вечный титан'],
      MAT_TONS,
      'т титана',
    ),
  },
  {
    id: 'cmm',
    title: 'Композитчик',
    subtitle: 'Завезено CMM-композита',
    color: '#c4b5fd',
    icon: '🛡️',
    match: isCmm,
    ranks: makeRanks(
      ['Первый слой', 'Матрица CMM', 'Композитный каркас', 'Броня CMM', 'Мастер композита',
       'CMM-архитектор', 'Полимерный повелитель', 'Композитный колосс', 'CMM-бог', 'Вечный композитчик'],
      MAT_TONS,
      'т CMM-композита',
    ),
  },
  {
    id: 'hubs',
    title: 'Первооткрыватель',
    subtitle: 'Уникальные хабы',
    color: '#2ecc71',
    icon: '🌌',
    match: () => false,
    ranks: makeCountRanks(
      ['Звёздный странник', 'Планетарный скаут', 'Исследователь кольца', 'Картограф хабов', 'Властелин галактики',
       'Галактический странник', 'Хаб-магнат', 'Повелитель систем', 'Картограф вселенной', 'Вечный первооткрыватель'],
      HUB_COUNTS,
      'хабов',
    ),
  },
  {
    id: 'ops',
    title: 'Оперативник',
    subtitle: 'Количество операций',
    color: '#f472b6',
    icon: '📡',
    match: () => false,
    ranks: makeCountRanks(
      ['Новичок', 'Оператор', 'Ветеран маршрута', 'Диспетчер кольца', 'Командир операций',
       'Машина доставок', 'Оперативный гений', 'Логистический архонт', 'Бог маршрутов', 'Вечный оперативник'],
      OPS_COUNTS,
      'операций',
    ),
  },
  {
    id: 'architect',
    title: 'Архитектор',
    subtitle: 'Системы как архитектор',
    color: '#22c55e',
    icon: '🏗️',
    match: () => false,
    ranks: makeCountRanks(
      ['Звёздный пионер', 'Колониальный застройщик', 'Архитектор кольца', 'Магистр колонизации', 'Легенда RavenColonial',
       'Колониальный титан', 'Звёздный магнат', 'Повелитель колоний', 'Галактический строитель', 'Вечный архитектор'],
      ARCH_COUNTS,
      'систем',
    ),
  },
];

/* ── Hero badges (overflow beyond Tier 10) ── */
export const HERO_BADGES = [
  {
    id: 'hero_cargo',
    trackId: 'cargo',
    name: 'Герой экспедиции',
    desc: '50 000 000+ тонн груза',
    icon: '👑',
    color: '#f39c12',
    threshold: 50_000_000,
  },
  {
    id: 'hero_steel',
    trackId: 'steel',
    name: 'Стальная легенда',
    desc: '25 000 000+ тонн стали',
    icon: '⚔️',
    color: '#eeeeee',
    threshold: 25_000_000,
  },
  {
    id: 'hero_titanium',
    trackId: 'titanium',
    name: 'Титановый бог',
    desc: '25 000 000+ тонн титана',
    icon: '💠',
    color: '#7dd3fc',
    threshold: 25_000_000,
  },
  {
    id: 'hero_cmm',
    trackId: 'cmm',
    name: 'Композитный оверлорд',
    desc: '25 000 000+ тонн CMM',
    icon: '🏰',
    color: '#c4b5fd',
    threshold: 25_000_000,
  },
  {
    id: 'hero_architect',
    trackId: 'architect',
    name: 'Властелин галактики',
    desc: '25 000+ систем как архитектор',
    icon: '🌠',
    color: '#f39c12',
    threshold: 25_000,
  },
  {
    id: 'hero_hubs',
    trackId: 'hubs',
    name: 'Галактический странник',
    desc: '5 000+ уникальных хабов',
    icon: '🚀',
    color: '#2ecc71',
    threshold: 5_000,
  },
  {
    id: 'hero_ops',
    trackId: 'ops',
    name: 'Машина доставок',
    desc: '500 000+ операций',
    icon: '⚡',
    color: '#f472b6',
    threshold: 500_000,
  },
];

/* ── Track value calculation ── */
export function trackValue(
  track: AchievementTrack,
  rows: { commodity: string; amount: number }[],
) {
  if (track.id === 'cargo') {
    return rows.reduce((s, r) => s + Number(r.amount), 0);
  }
  return rows.reduce((s, r) => (track.match(r.commodity) ? s + Number(r.amount) : s), 0);
}

/* ── Rank progress (Inara-style) ── */
export function rankProgress(
  track: { ranks: AchievementRank[]; color: string },
  count: number,
): TrackProgress {
  let earned = 0;
  for (const r of track.ranks) {
    if (count >= r.threshold) earned = r.rank;
  }
  const current = earned > 0 ? track.ranks[earned - 1] : null;
  const next = track.ranks.find((r) => count < r.threshold) ?? null;
  const prevThreshold = earned > 0 ? track.ranks[earned - 1].threshold : 0;
  const span = next ? next.threshold - prevThreshold : 1;
  const into = next ? Math.min(1, Math.max(0, (count - prevThreshold) / span)) : 1;
  return {
    earned,
    current,
    next,
    into,
    color: TIER_COLORS[Math.max(0, earned - 1)],
    total: count,
  };
}

/* ── Styling helpers ── */
export function tierColor(rank: number) {
  return TIER_COLORS[Math.max(0, Math.min(9, rank - 1))];
}

export function tierBg(rank: number) {
  return TIER_BG[Math.max(0, Math.min(9, rank - 1))];
}

export function tierBorder(rank: number) {
  return TIER_BORDER[Math.max(0, Math.min(9, rank - 1))];
}

/* ── Hero badge check ── */
export function checkHeroBadges(
  totals: Record<string, number>,
) {
  return HERO_BADGES.filter((h) => {
    const val = totals[h.trackId] ?? 0;
    return val >= h.threshold;
  });
}

/* ── Summary stats for a pilot ── */
export function pilotAchievements(
  deliveries: { commodity: string; amount: number; system_name: string }[],
  architectCount: number,
  hubsCount: number,
  opsCount: number,
) {
  const totals: Record<string, number> = {};
  for (const t of ACHIEVEMENT_TRACKS) {
    if (t.id === 'architect') totals[t.id] = architectCount;
    else if (t.id === 'hubs') totals[t.id] = hubsCount;
    else if (t.id === 'ops') totals[t.id] = opsCount;
    else totals[t.id] = trackValue(t, deliveries);
  }

  const progress = ACHIEVEMENT_TRACKS.map((t) => ({
    track: t,
    ...rankProgress(t, totals[t.id]),
  }));

  const heroes = checkHeroBadges(totals);
  const totalTiers = progress.reduce((s, p) => s + p.earned, 0);

  return { totals, progress, heroes, totalTiers };
}
