/**
 * MercGear: модули и чертежи за Merc Coin (обновление «Operations»).
 *
 * Merc Coin — валюта за операции: её тратят у обычных продавцов в верфи и у
 * инженеров. За жетоны продаётся две разные вещи, и их нельзя путать:
 *
 *  * готовые модули (предзаряженные орудия, реакторы, грузовые отсеки…) —
 *    их ставят в слоты, как обычные модули;
 *  * рецепты чертежей (Thermal Plasma Conversion, Scoop Rate Enhanced) —
 *    их применяет инженер, поэтому в списке они лежат отдельным видом
 *    `kind: 'blueprint'` и не ссылаются на модуль.
 *
 * В наборе Coriolis цены в жетонах не хранятся (там только кредиты, а у
 * предзаряженных модулей стоит `cost: 0`), поэтому список собран вручную по
 * патчноутам Frontier и сводкам сообщества. Официальное название модуля —
 * из патчноута; внутренние коды — из EDCD/FDevIDs (`mercgear`) и EDCD/EDDI.
 *
 * `ref` или `refs` указывают на модуль справочника (`группа:id`) — по ним
 * верфь ставит значок «за Merc Coin» в списках, в подсказке и в смете сборки.
 * Если модуля в наборе данных ещё нет, запись всё равно показывается в справке
 * раздела — так видно, что из MercGear уже можно поставить, а что нет.
 */

export type MercKind = 'hardpoint' | 'core' | 'internal' | 'blueprint';

export interface MercCoinEntry {
  id: string;
  kind: MercKind;
  /** Ссылка на модуль справочника: `группа:id`. */
  ref?: string;
  /** Ссылки для модулей, которые бывают нескольких классов. */
  refs?: string[];
  /** Группа модулей, к которой относится чертёж (для `kind: 'blueprint'`). */
  groups?: string[];
  /** Английское название из патчноутов — оно же в игре. */
  name: string;
  /** Классы/рейтинги, в которых встречается. */
  sizes?: string;
  /** Цена покупки в Merc Coin (базовый уровень). */
  coins?: number;
  /** Стоимость прогона по уровням инженерии, Merc Coin. */
  upgrade?: Partial<Record<2 | 3 | 4 | 5, number>>;
  /** Ключ перевода примечания, если у записи есть оговорка. */
  noteKey?: string;
}

export const MERC_COIN_ITEMS: MercCoinEntry[] = [
  // ── Чертежи инженеров за Merc Coin ──
  {
    id: 'thermal_plasma_conversion',
    kind: 'blueprint',
    groups: ['bl', 'pl', 'ul'],
    name: 'Thermal Plasma Conversion',
  },
  {
    id: 'scoop_rate_enhanced',
    kind: 'blueprint',
    groups: ['fs'],
    name: 'Scoop Rate Enhanced',
    coins: 350,
    upgrade: { 2: 25, 3: 50, 4: 75, 5: 100 },
  },

  // ── Предзаряженные орудия ──
  {
    id: 'enduring_feedback_railgun',
    kind: 'hardpoint',
    ref: 'rg:6C',
    name: 'Enduring Feedback Rail Gun',
    sizes: '2B',
  },
  {
    id: 'far_reaching_abrasion_blaster',
    kind: 'hardpoint',
    ref: 'abl:6A',
    name: 'Far-Reaching Abrasion Blaster',
    sizes: '1D',
  },
  {
    id: 'double_screaming_frag',
    kind: 'hardpoint',
    refs: ['fc:MA', 'fc:MB'],
    name: 'Double Screaming Fragment Cannon',
    sizes: '1E, 3C',
  },
  {
    id: 'long_range_mining_laser',
    kind: 'hardpoint',
    ref: 'ml:5Y',
    name: 'Long Range Mining Laser',
    sizes: '1D',
  },
  {
    id: 'rapid_phase_multicannon',
    kind: 'hardpoint',
    ref: 'mc:6D',
    name: 'Rapid Phase Multi-Cannon',
    sizes: '2E',
  },
  {
    id: 'drag_seeker',
    kind: 'hardpoint',
    ref: 'mr:6B',
    name: 'Drag Seeker Missile Rack',
    sizes: '2B',
  },
  {
    id: 'lightweight_thermal_seeker',
    kind: 'hardpoint',
    ref: 'mr:5X',
    name: 'Lightweight Thermal Seeker Missile Rack',
    sizes: '2B',
  },
  {
    id: 'lockdown_seeker',
    kind: 'hardpoint',
    refs: ['mr:MA', 'mr:MB'],
    name: 'Lockdown Seeker Missile Rack',
    sizes: '2B, 3A',
  },
  {
    id: 'high_yield_enzyme',
    kind: 'hardpoint',
    ref: 'tbem:5Z',
    name: 'High-Yield Enzyme Missile Rack',
    sizes: '2B',
  },

  // ── Предзаряженные основные модули ──
  {
    id: 'support_focused_pd',
    kind: 'core',
    refs: ['pd:M1', 'pd:M2', 'pd:M3', 'pd:M4', 'pd:M5'],
    name: 'Support Focused Power Distributor',
    sizes: '3A, 3D, 4A, 4D, 6A',
  },
  {
    id: 'balanced_pd',
    kind: 'core',
    ref: 'pd:M6',
    name: 'Balanced Power Distributor',
    sizes: '5A',
  },

  // ── Предзаряженные внутренние модули ──
  {
    id: 'extended_cargo_rack_5',
    kind: 'internal',
    ref: 'cr:7X',
    name: 'Extended Cargo Rack',
    sizes: '5E',
    coins: 550,
    upgrade: { 2: 15, 3: 20, 4: 40, 5: 50 },
  },
  {
    id: 'extended_cargo_rack_6',
    kind: 'internal',
    ref: 'cr:7Y',
    name: 'Extended Cargo Rack',
    sizes: '6E',
    coins: 550,
    upgrade: { 2: 15, 3: 20, 4: 40, 5: 50 },
  },
  {
    id: 'long_range_dss',
    kind: 'internal',
    ref: 'ss:5V',
    name: 'Long Range Detailed Surface Scanner',
    sizes: '1I',
    coins: 350,
    noteKey: 'outfitting.merc.note.dss',
  },
  {
    id: 'heavy_duty_mrp',
    kind: 'internal',
    ref: 'mrp:MA',
    name: 'Heavy Duty Module Reinforcement Package',
    sizes: '5D',
    upgrade: { 2: 5, 3: 5, 4: 10, 5: 25 },
  },
];

const BY_REF = new Map<string, MercCoinEntry>();
for (const entry of MERC_COIN_ITEMS) {
  for (const ref of [entry.ref, ...(entry.refs ?? [])]) {
    if (ref) BY_REF.set(ref, entry);
  }
}

/** MercGear-запись для модуля сборки, если он покупается за Merc Coin. */
export function mercEntryForRef(ref: string | null | undefined): MercCoinEntry | null {
  if (!ref) return null;
  return BY_REF.get(ref) ?? null;
}

/**
 * Рецепты чертежей, которые инженер продаёт за Merc Coin и которые подходят
 * группе модуля. Для лазеров это Thermal Plasma Conversion, для
 * топливозаборников — Scoop Rate Enhanced.
 */
export function mercBlueprintsForGroup(group: string): MercCoinEntry[] {
  return MERC_COIN_ITEMS.filter(
    (entry) => entry.kind === 'blueprint' && (entry.groups ?? []).includes(group),
  );
}

/** MercGear-запись по группе и id модуля. */
export function mercEntryFor(group: string, id: string): MercCoinEntry | null {
  return BY_REF.get(`${group}:${id}`) ?? null;
}

/** Все ссылки записи на модули справочника. */
export function mercRefsOf(entry: MercCoinEntry): string[] {
  return [entry.ref, ...(entry.refs ?? [])].filter((ref): ref is string => Boolean(ref));
}

/** Сколько жетонов стоит собранный корабль (учитываются только MercGear). */
export function mercCoinCost(refs: (string | null | undefined)[]): number {
  let total = 0;
  for (const ref of refs) {
    const entry = mercEntryForRef(ref);
    if (entry?.coins) total += entry.coins;
  }
  return total;
}

/** Сумма прогонов инженера до указанного уровня, Merc Coin. */
export function mercUpgradeCost(entry: MercCoinEntry, grade: number): number {
  if (!entry.upgrade) return 0;
  let total = 0;
  for (let level = 2 as 2 | 3 | 4 | 5; level <= grade; level = (level + 1) as 2 | 3 | 4 | 5) {
    total += entry.upgrade[level] ?? 0;
  }
  return total;
}
