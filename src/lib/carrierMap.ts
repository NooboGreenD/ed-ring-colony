/**
 * Авианосцы на карте галактики (`/map`) и в Atlas (`/atlas`).
 *
 * Здесь общий тип ответа `GET /api/map/carriers` и всё, что карта делает с
 * ним в браузере: фильтр слоя (чьи носители и какого класса), счётчики для
 * панели, группировка по системам (одна отметка на систему со счётчиком) и
 * выбор значка группы. Чистые функции без зависимостей — их импортируют и
 * маршрут на сервере, и клиентская карта, и тесты (`node --test`).
 *
 * Значок — как в игре: на навигационной панели и на картах системы/галактики
 * авианосец показан контуром корпуса с «окном» ангара в круге, свой носитель
 * подсвечен жёлтым (см. `components/GalaxyMap/CarrierGlyph.tsx`).
 */

import { systemKey } from './systemIdentity.ts';

export type MapCarrierRelation = 'own' | 'squadron' | 'other';
export type MapCarrierType = 'FleetCarrier' | 'SquadronCarrier';

export interface MapPoint {
  x: number;
  y: number;
  z: number;
}

export interface MapCarrierJump {
  system: string;
  departureAt: string | null;
  /** `scheduled` — прыжок заказан, `jumping` — время вылета прошло, носитель в прыжке. */
  state: 'scheduled' | 'jumping';
  position: MapPoint | null;
}

/** Один носитель в ответе карты. Груза и финансов здесь нет никогда. */
export interface MapCarrier {
  /** Carrier ID (MarketID) — в игре его видит любой пилот, состыковавшийся с носителем. */
  id: string;
  type: MapCarrierType;
  callsign: string | null;
  name: string | null;
  /** Кем носитель приходится зрителю: свой, эскадрильи, чужой. */
  relation: MapCarrierRelation;
  /** Имя владельца: только если он не скрыл местоположение (себя пилот видит всегда). */
  owner: string | null;
  /** У носителя есть владелец на сайте, но имя скрыто его настройками приватности. */
  ownerHidden: boolean;
  squadron: { id: number; name: string | null; tag: string | null; member: boolean } | null;
  system: string;
  body: string | null;
  position: MapPoint | null;
  /** Время последнего подтверждения стоянки (журнал/рынок). */
  locationAt: string | null;
  /** Прыжок должен был завершиться, подтверждения ещё нет: `system` — цель прыжка. */
  estimated: boolean;
  previousSystem: string | null;
  jump: MapCarrierJump | null;
  /** Кого пускают на стыковку (подпись по-русски). */
  docking: string | null;
  notorious: boolean | null;
  /** Работающие службы носителя (подписи). */
  services: string[];
  /** Носитель списывается (в игре — серая строка навигационной панели). */
  decommission: boolean;
}

export interface MapCarriersResponse {
  carriers: MapCarrier[];
  viewer: { signedIn: boolean };
  generatedAt: string;
}

export const MAP_CARRIER_RELATIONS: readonly MapCarrierRelation[] = ['own', 'squadron', 'other'];
export const MAP_CARRIER_TYPES: readonly MapCarrierType[] = ['FleetCarrier', 'SquadronCarrier'];

export const CARRIER_RELATION_LABEL: Record<MapCarrierRelation, string> = {
  own: 'Мой',
  squadron: 'Эскадрилья',
  other: 'Другие',
};

export const CARRIER_RELATION_HINT: Record<MapCarrierRelation, string> = {
  own: 'ваш носитель',
  squadron: 'носитель эскадрильи',
  other: 'чужой носитель',
};

export const CARRIER_TYPE_LABEL: Record<MapCarrierType, string> = {
  FleetCarrier: 'Drake',
  SquadronCarrier: 'Javelin',
};

export const CARRIER_TYPE_FULL: Record<MapCarrierType, string> = {
  FleetCarrier: 'личный (Drake)',
  SquadronCarrier: 'эскадренный (Javelin)',
};

/** Тон значка: чей носитель; списываемый носитель серый, как в игре. */
export type CarrierTone = MapCarrierRelation | 'decommission';

export const CARRIER_TONE_COLOR: Record<CarrierTone, string> = {
  // Свой носитель в игре подсвечен жёлтым.
  own: '#ffd166',
  squadron: '#4ade80',
  // Остальные — оранжевым цветом HUD, как значок на навигационной панели.
  other: '#ff8a2a',
  decommission: '#9ca3af',
};

/** Стоянка старше двух недель — значок бледнеет: носитель мог давно улететь. */
export const CARRIER_STALE_MS = 14 * 24 * 60 * 60 * 1000;

export interface CarrierLayerFilter {
  relations: Record<MapCarrierRelation, boolean>;
  types: Record<MapCarrierType, boolean>;
}

export const DEFAULT_CARRIER_FILTER: CarrierLayerFilter = {
  relations: { own: true, squadron: true, other: true },
  types: { FleetCarrier: true, SquadronCarrier: true },
};

/** Ключ сравнения систем: регистр и лишние пробелы не важны. */
/** Ключ системы — общий для всего проекта (`systemIdentity.ts`). */
export const carrierSystemKey = systemKey;

export function isMapPoint(value: unknown): value is MapPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return [point.x, point.y, point.z].every((axis) => typeof axis === 'number' && Number.isFinite(axis));
}

export function filterMapCarriers(carriers: readonly MapCarrier[], filter: CarrierLayerFilter): MapCarrier[] {
  return carriers.filter((carrier) => filter.relations[carrier.relation] !== false && filter.types[carrier.type] !== false);
}

/** Фильтр ничего не отсекает. */
export function isDefaultCarrierFilter(filter: CarrierLayerFilter): boolean {
  return MAP_CARRIER_RELATIONS.every((relation) => filter.relations[relation] !== false)
    && MAP_CARRIER_TYPES.every((type) => filter.types[type] !== false);
}

export function toggleCarrierRelation(filter: CarrierLayerFilter, relation: MapCarrierRelation): CarrierLayerFilter {
  return { ...filter, relations: { ...filter.relations, [relation]: !filter.relations[relation] } };
}

export function toggleCarrierType(filter: CarrierLayerFilter, type: MapCarrierType): CarrierLayerFilter {
  return { ...filter, types: { ...filter.types, [type]: !filter.types[type] } };
}

export interface CarrierCounts {
  total: number;
  /** Сколько из них можно поставить на карту (известны координаты системы). */
  placed: number;
  /** В скольких системах стоят. */
  systems: number;
  relations: Record<MapCarrierRelation, number>;
  types: Record<MapCarrierType, number>;
}

export function countMapCarriers(carriers: readonly MapCarrier[]): CarrierCounts {
  const counts: CarrierCounts = {
    total: carriers.length,
    placed: 0,
    systems: 0,
    relations: { own: 0, squadron: 0, other: 0 },
    types: { FleetCarrier: 0, SquadronCarrier: 0 },
  };
  const systems = new Set<string>();
  for (const carrier of carriers) {
    if (carrier.position) counts.placed += 1;
    systems.add(carrierSystemKey(carrier.system));
    counts.relations[carrier.relation] = (counts.relations[carrier.relation] ?? 0) + 1;
    counts.types[carrier.type] = (counts.types[carrier.type] ?? 0) + 1;
  }
  counts.systems = systems.size;
  return counts;
}

const RELATION_ORDER: Record<MapCarrierRelation, number> = { own: 0, squadron: 1, other: 2 };

export function carrierTitle(carrier: Pick<MapCarrier, 'name' | 'callsign' | 'id'>): string {
  return carrier.name?.trim() || carrier.callsign || `FC ${carrier.id}`;
}

/**
 * Порядок носителей в системе: свои, эскадрильи, чужие; внутри — Javelin
 * раньше Drake, списываемые в конце, дальше по имени.
 */
export function compareMapCarriers(left: MapCarrier, right: MapCarrier): number {
  return RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation]
    || Number(left.decommission) - Number(right.decommission)
    || (left.type === right.type ? 0 : left.type === 'SquadronCarrier' ? -1 : 1)
    || carrierTitle(left).localeCompare(carrierTitle(right), 'ru')
    || left.id.localeCompare(right.id);
}

export interface CarrierSystemGroup {
  key: string;
  system: string;
  position: MapPoint | null;
  /** Отсортированы `compareMapCarriers`: первый задаёт значок группы. */
  carriers: MapCarrier[];
  lead: MapCarrier;
  relations: Record<MapCarrierRelation, number>;
  /** Прыжки из этой системы (по одной цели на систему назначения). */
  jumps: Array<{ key: string; system: string; position: MapPoint | null; state: 'scheduled' | 'jumping'; departureAt: string | null; carrier: MapCarrier }>;
}

/** Одна отметка на систему: значок ведущего носителя и счётчик остальных. */
export function groupCarriersBySystem(carriers: readonly MapCarrier[]): CarrierSystemGroup[] {
  const byKey = new Map<string, MapCarrier[]>();
  for (const carrier of carriers) {
    const key = carrierSystemKey(carrier.system);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(carrier);
    else byKey.set(key, [carrier]);
  }

  const groups: CarrierSystemGroup[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort(compareMapCarriers);
    const lead = sorted[0];
    const position = sorted.find((carrier) => carrier.position)?.position ?? null;
    const relations: Record<MapCarrierRelation, number> = { own: 0, squadron: 0, other: 0 };
    for (const carrier of sorted) relations[carrier.relation] += 1;
    const jumps: CarrierSystemGroup['jumps'] = [];
    const seenTargets = new Set<string>();
    for (const carrier of sorted) {
      if (!carrier.jump) continue;
      const target = carrierSystemKey(carrier.jump.system);
      if (!target || target === key || seenTargets.has(target)) continue;
      seenTargets.add(target);
      jumps.push({
        key: target,
        system: carrier.jump.system,
        position: carrier.jump.position,
        state: carrier.jump.state,
        departureAt: carrier.jump.departureAt,
        carrier,
      });
    }
    groups.push({ key, system: lead.system, position, carriers: sorted, lead, relations, jumps });
  }

  return groups.sort((left, right) => RELATION_ORDER[left.lead.relation] - RELATION_ORDER[right.lead.relation]
    || right.carriers.length - left.carriers.length
    || left.system.localeCompare(right.system, 'ru'));
}

export function isCarrierStale(carrier: Pick<MapCarrier, 'locationAt' | 'estimated'>, now = Date.now()): boolean {
  if (carrier.estimated) return false;
  const at = carrier.locationAt ? Date.parse(carrier.locationAt) : NaN;
  return !Number.isFinite(at) || now - at > CARRIER_STALE_MS;
}

/** Прозрачность значка: свежая стоянка, оценка после прыжка, давняя стоянка, цель прыжка. */
export type CarrierFade = 'fresh' | 'estimated' | 'stale' | 'ghost';

export const CARRIER_FADE_OPACITY: Record<CarrierFade, number> = {
  fresh: 1,
  estimated: 0.8,
  stale: 0.5,
  ghost: 0.42,
};

export interface CarrierIconVariant {
  glyph: 'drake' | 'javelin';
  tone: CarrierTone;
  /** Сколько носителей в системе (бейдж на значке при двух и больше). */
  count: number;
  fade: CarrierFade;
}

export function carrierIconVariant(group: Pick<CarrierSystemGroup, 'lead' | 'carriers'>, now = Date.now()): CarrierIconVariant {
  const { lead } = group;
  const fade: CarrierFade = group.carriers.every((carrier) => isCarrierStale(carrier, now))
    ? 'stale'
    : lead.estimated ? 'estimated' : 'fresh';
  return {
    glyph: lead.type === 'SquadronCarrier' ? 'javelin' : 'drake',
    tone: lead.decommission ? 'decommission' : lead.relation,
    count: group.carriers.length,
    fade,
  };
}

export function carrierTone(carrier: Pick<MapCarrier, 'relation' | 'decommission'>): CarrierTone {
  return carrier.decommission ? 'decommission' : carrier.relation;
}

/** Текст бейджа: до девяти — число, дальше «9+». */
export function carrierBadgeText(count: number): string {
  return count > 9 ? '9+' : String(Math.max(0, Math.floor(count)));
}

/** «5 мин назад», «через 12 мин», «3 ч назад», «2 дн назад». */
export function carrierRelativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.round((ms - now) / 60000);
  const abs = Math.abs(diff);
  const text = abs < 1 ? 'меньше минуты'
    : abs < 60 ? `${abs} мин`
      : abs < 48 * 60 ? `${Math.round(abs / 60)} ч`
        : `${Math.round(abs / 1440)} дн`;
  return diff >= 0 ? `через ${text}` : `${text} назад`;
}

/** Строка о прыжке для карточки и подсказки. */
export function carrierJumpText(carrier: Pick<MapCarrier, 'jump'>, now = Date.now()): string | null {
  const { jump } = carrier;
  if (!jump) return null;
  if (jump.state === 'jumping') return `в прыжке → ${jump.system}`;
  const when = carrierRelativeTime(jump.departureAt, now);
  return when ? `прыжок → ${jump.system}, вылет ${when}` : `прыжок → ${jump.system}`;
}

/** Где и насколько свежо: «данные 3 ч назад» или оценка после прыжка. */
export function carrierLocationText(carrier: Pick<MapCarrier, 'estimated' | 'previousSystem' | 'locationAt'>, now = Date.now()): string {
  if (carrier.estimated) {
    return `≈ прибыл после прыжка${carrier.previousSystem ? ` из ${carrier.previousSystem}` : ''}, подтверждения ещё нет`;
  }
  const age = carrierRelativeTime(carrier.locationAt, now);
  return age ? `данные ${age}` : 'время стоянки неизвестно';
}

/** «1 носитель», «3 носителя», «12 носителей». */
export function carrierCountLabel(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const tens = n % 100;
  const ones = n % 10;
  const word = tens > 10 && tens < 20 ? 'носителей'
    : ones === 1 ? 'носитель'
      : ones >= 2 && ones <= 4 ? 'носителя'
        : 'носителей';
  return `${n} ${word}`;
}

/** Имена первых носителей системы: «Alpha, Beta и ещё 2». */
export function carrierListLabel(group: Pick<CarrierSystemGroup, 'carriers'>, limit = 2): string {
  const names = group.carriers.slice(0, limit).map(carrierTitle);
  const rest = group.carriers.length - names.length;
  return rest > 0 ? `${names.join(', ')} и ещё ${rest}` : names.join(', ');
}
