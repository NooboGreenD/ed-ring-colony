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
/**
 * Откуда запись: `site` — учёт сайта (`fleet_carriers`: владелец, эскадрилья,
 * подтверждённая стоянка), `eddn` — живой поток EDDN (`carrier_directory`).
 * У записи из реестра нет владельца, эскадрильи и прыжка — только факт
 * «носитель был здесь»; и это честно видно на карте.
 */
export type MapCarrierSource = 'site' | 'eddn';

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

/**
 * Один известный прыжок носителя: «откуда → куда», когда и откуда узнали.
 *
 * История копится в `carrier_jump_history` (учёт сайта и EDDN). Карта берёт
 * прыжки за `CARRIER_HISTORY_WINDOW_MS` (неделя) и рисует по ним след, а
 * карточка системы показывает их списком. Координаты приходят с сервера:
 * браузер их не ищет, а система без координат просто не попадает на линию.
 */
export interface CarrierJumpHistoryEntry {
  from: string;
  to: string;
  jumpedAt: string;
  source: MapCarrierSource;
  fromPosition: MapPoint | null;
  toPosition: MapPoint | null;
}

/**
 * Окно истории на карте и в карточке: неделя.
 *
 * Раньше думали про «последние пять прыжков», но пять прыжков — это разный
 * срок для разных носителей: у одного неделя, у другого месяц. Период честнее:
 * на карте видно, что случилось за последние семь дней, и у всех носителей
 * одинаково. Полная история (час/день/месяц/год) — во вкладке «История».
 */
export const CARRIER_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Страховка от мусора в данных: столько строк на носителя карта не покажет. */
export const CARRIER_HISTORY_MAX_PER_CARRIER = 50;

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
  /** Координаты системы, откуда носитель пришёл последним прыжком (если известны). */
  previousPosition?: MapPoint | null;
  jump: MapCarrierJump | null;
  /** Кого пускают на стыковку (подпись по-русски). */
  docking: string | null;
  notorious: boolean | null;
  /** Работающие службы носителя (подписи). */
  services: string[];
  /** Носитель списывается (в игре — серая строка навигационной панели). */
  decommission: boolean;
  /**
   * Откуда запись: `site` — учёт сайта (`fleet_carriers`: владелец, эскадрилья),
   * `eddn` — только реестр из живого потока EDDN (`carrier_directory`).
   * У записи из EDDN нет владельца, эскадрильи и груза — и это честно видно.
   */
  origin?: MapCarrierSource;
  /**
   * Прыжки за последнюю неделю, свежие сверху (см. `CARRIER_HISTORY_WINDOW_MS`).
   * Пустой массив — истории нет: носитель новый или учёт ещё не видел прыжка.
   */
  history?: readonly CarrierJumpHistoryEntry[];
}

export interface MapDirectoryInfo {
  /** Сколько записей реестра EDDN попало в ответ. */
  shown: number;
  /** Реестр обрезан: нашлось больше, чем помещается на карту. */
  truncated: boolean;
  /** Граница свежести: записи старше этого срока на карту не берутся. */
  since: string;
}

/** Состояние загрузки слоя: у карты и у панели вкладки оно одно. */
export type CarrierLayerStatus = 'loading' | 'ready' | 'error';

export interface MapCarriersResponse {
  carriers: MapCarrier[];
  viewer: { signedIn: boolean };
  generatedAt: string;
  /** Реестр EDDN: сколько записей подмешано и не обрезали ли мы его. */
  directory?: MapDirectoryInfo;
}

export const MAP_CARRIER_RELATIONS: readonly MapCarrierRelation[] = ['own', 'squadron', 'other'];
export const MAP_CARRIER_TYPES: readonly MapCarrierType[] = ['FleetCarrier', 'SquadronCarrier'];
export const MAP_CARRIER_SOURCES: readonly MapCarrierSource[] = ['site', 'eddn'];

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

export const CARRIER_SOURCE_LABEL: Record<MapCarrierSource, string> = {
  site: 'Сайт',
  eddn: 'EDDN',
};

export const CARRIER_SOURCE_COLOR: Record<MapCarrierSource, string> = {
  site: '#e67e22',
  eddn: '#60a5fa',
};

/** Откуда отметка; старая запись без поля — из учёта сайта. */
export function carrierSourceOf(carrier: Pick<MapCarrier, 'origin'>): MapCarrierSource {
  return carrier.origin === 'eddn' ? 'eddn' : 'site';
}

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
  /** Источник записи: учёт сайта или реестр EDDN. */
  sources: Record<MapCarrierSource, boolean>;
  /**
   * Рисовать ли линии выполненных прыжков за неделю. На число носителей не
   * влияет — это только следы на карте; в карточке системы история остаётся.
   */
  history: boolean;
}

export const DEFAULT_CARRIER_FILTER: CarrierLayerFilter = {
  relations: { own: true, squadron: true, other: true },
  types: { FleetCarrier: true, SquadronCarrier: true },
  // «Все носители» — по умолчанию: карта показывает и подтверждённые стоянки,
  // и реестр EDDN, а переключатель позволяет оставить только свои.
  sources: { site: true, eddn: true },
  // История за неделю — включена: без неё слой выглядит как точки без маршрута.
  history: true,
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
  return carriers.filter((carrier) => filter.relations[carrier.relation] !== false
    && filter.types[carrier.type] !== false
    && filter.sources?.[carrierSourceOf(carrier)] !== false);
}

/**
 * Фильтр не отсекает ни одного носителя.
 *
 * Выключенные линии истории сюда не входят: они не меняют число носителей, а
 * счётчик в панели показывает именно его — иначе «5/5» пугало бы зря.
 */
export function isDefaultCarrierFilter(filter: CarrierLayerFilter): boolean {
  return MAP_CARRIER_RELATIONS.every((relation) => filter.relations[relation] !== false)
    && MAP_CARRIER_TYPES.every((type) => filter.types[type] !== false)
    && MAP_CARRIER_SOURCES.every((source) => filter.sources?.[source] !== false);
}

/** Линии истории включены (старый объект фильтра без поля — включены). */
export function carrierHistoryShown(filter: Pick<CarrierLayerFilter, 'history'> | null | undefined): boolean {
  return filter?.history !== false;
}

export function toggleCarrierHistory(filter: CarrierLayerFilter): CarrierLayerFilter {
  return { ...filter, history: !carrierHistoryShown(filter) };
}

export function toggleCarrierRelation(filter: CarrierLayerFilter, relation: MapCarrierRelation): CarrierLayerFilter {
  return { ...filter, relations: { ...filter.relations, [relation]: !filter.relations[relation] } };
}

export function toggleCarrierType(filter: CarrierLayerFilter, type: MapCarrierType): CarrierLayerFilter {
  return { ...filter, types: { ...filter.types, [type]: !filter.types[type] } };
}

export function toggleCarrierSource(filter: CarrierLayerFilter, source: MapCarrierSource): CarrierLayerFilter {
  return { ...filter, sources: { ...filter.sources, [source]: !filter.sources[source] } };
}

export interface CarrierCounts {
  total: number;
  /** Сколько из них можно поставить на карту (известны координаты системы). */
  placed: number;
  /** В скольких системах стоят. */
  systems: number;
  relations: Record<MapCarrierRelation, number>;
  types: Record<MapCarrierType, number>;
  /** Сколько отметок пришло из учёта сайта и сколько из реестра EDDN. */
  sources: Record<MapCarrierSource, number>;
}

export function countMapCarriers(carriers: readonly MapCarrier[]): CarrierCounts {
  const counts: CarrierCounts = {
    total: carriers.length,
    placed: 0,
    systems: 0,
    relations: { own: 0, squadron: 0, other: 0 },
    types: { FleetCarrier: 0, SquadronCarrier: 0 },
    sources: { site: 0, eddn: 0 },
  };
  const systems = new Set<string>();
  for (const carrier of carriers) {
    if (carrier.position) counts.placed += 1;
    systems.add(carrierSystemKey(carrier.system));
    counts.relations[carrier.relation] = (counts.relations[carrier.relation] ?? 0) + 1;
    counts.types[carrier.type] = (counts.types[carrier.type] ?? 0) + 1;
    counts.sources[carrierSourceOf(carrier)] += 1;
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

/** Отрезок выполненного прыжка — линия на карте и строка в карточке. */
export interface CarrierRouteLeg {
  /** `lave>hip 100` — уникален внутри группы. */
  key: string;
  /** Откуда прыгнули. */
  system: string;
  position: MapPoint;
  /** Куда пришли. */
  target: string;
  targetPosition: MapPoint;
  /** Время прыжка; `null` — известен только факт (след реестра без даты). */
  jumpedAt: string | null;
  source: MapCarrierSource;
  /** 0 — самый свежий прыжок носителя: линия ярче, у старых прозрачнее. */
  age: number;
  carrier: MapCarrier;
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
  /**
   * Выполненные прыжки носителей группы: отрезки «откуда → куда». Рисуются
   * сплошными бледными линиями — в отличие от пунктира запланированного
   * прыжка. Свежий прыжок ярче, старые бледнее: по линии видно направление
   * времени. Одна линия на пару систем, без повторов и петель.
   */
  routes: CarrierRouteLeg[];
}

/**
 * Линии выполненных прыжков группы: по одной на пару «откуда → куда».
 *
 * Источник — `carrier.history`: прыжки за последнюю неделю, свежие сверху.
 * Если истории нет (старая запись, носитель без прыжков в учёте), остаётся
 * прежний след `previousSystem` — одна линия «откуда пришёл → здесь».
 *
 * Петли (`from === to`), отрезки без координат и повторы отбрасываются:
 * несколько носителей, прыгавших одним маршрутом, дают одну линию, а не пять
 * поверх друг друга. `age` — номер нарисованного отрезка у носителя (свежий —
 * 0): по нему карта гасит старые линии.
 */
function carrierRouteLegs(carriers: readonly MapCarrier[], groupKey: string): CarrierRouteLeg[] {
  const legs: CarrierRouteLeg[] = [];
  const seen = new Set<string>();
  const push = (leg: CarrierRouteLeg): boolean => {
    const from = carrierSystemKey(leg.system);
    const to = carrierSystemKey(leg.target);
    if (!from || !to || from === to) return false;
    if (from === groupKey && to === groupKey) return false;
    const key = `${from}>${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    legs.push({ ...leg, key });
    return true;
  };

  for (const carrier of carriers) {
    const history = (carrier.history ?? []).slice(0, CARRIER_HISTORY_MAX_PER_CARRIER);
    if (history.length) {
      // `age` — номер уже нарисованного отрезка, а не индекс строки: дубли и
      // петли выпадают, и без этого между свежими линиями были бы дыры в
      // прозрачности.
      let age = 0;
      for (const entry of history) {
        if (!entry.fromPosition || !entry.toPosition) continue;
        const drawn = push({
          key: '',
          system: entry.from,
          position: entry.fromPosition,
          target: entry.to,
          targetPosition: entry.toPosition,
          jumpedAt: entry.jumpedAt || null,
          source: entry.source,
          age,
          carrier,
        });
        if (drawn) age += 1;
      }
      continue;
    }
    // След реестра: точку назначения знаем только по самой отметке.
    const target = carrier.position;
    if (!carrier.previousSystem || !carrier.previousPosition || !target) continue;
    push({
      key: '',
      system: String(carrier.previousSystem).trim(),
      position: carrier.previousPosition,
      target: carrier.system,
      targetPosition: target,
      jumpedAt: null,
      source: carrierSourceOf(carrier),
      age: 0,
      carrier,
    });
  }

  return legs.sort((left, right) => left.age - right.age || left.system.localeCompare(right.system, 'ru'));
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
    const routes = carrierRouteLegs(sorted, key);
    groups.push({ key, system: lead.system, position, carriers: sorted, lead, relations, jumps, routes });
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
