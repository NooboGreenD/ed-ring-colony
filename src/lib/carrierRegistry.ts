/**
 * Реестр авианосцев галактики: что берём из EDDN и что — только от людей.
 *
 * Frontier реестр носителей не публикует. Зато каждый прыжок авианосца его
 * владелец (или пилот на борту) отправляет в EDDN, и оттуда `journal/1` c
 * событием `CarrierJump` приносит MarketID, позывной, систему с координатами,
 * тело и службы. Имени носителя в этом событии **нет**: игра показывает имя
 * только владельцу в `CarrierStats`, остальным — позывной.
 *
 * Поэтому правило простое и живёт здесь целиком:
 *   * EDDN обновляет локацию и службы — и никогда имя;
 *   * имя приходит только от людей: от владельца (его журнал) или от пилота,
 *     который побывал на носителе (его журнал либо явное уточнение в Атласе).
 *
 * Чистые функции без БД и React: их вызывают маршрут EDDN, приём журналов и
 * тесты, поэтому правила не могут разойтись между путями.
 */

import { FC_MARKET_MAX, FC_MARKET_MIN } from './fleetCarrierCollector';

export type CarrierRegistrySource = 'eddn' | 'site';

/** Строка реестра, которую пишем в `carrier_directory`. */
export interface CarrierRegistryRow {
  carrier_id: string;
  callsign?: string | null;
  carrier_type?: 'FleetCarrier' | 'SquadronCarrier' | null;
  system_name?: string | null;
  system_address?: number | null;
  body_name?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  services?: string[] | null;
  observed_at: string;
}

/** Визит: пилот стоял на носителе (журнал `Docked`/`CarrierJump`). */
export interface CarrierVisitRow {
  carrier_id: string;
  observed_at: string;
}

export const CARRIER_NAME_MAX = 80;

/** Позывной Drake-Class: «K7Q-BQL». */
export function isCarrierCallsign(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(value.trim().toUpperCase());
}

/** MarketID носителя: 3.7…3.8 млрд. */
export function isCarrierMarketId(value: unknown): boolean {
  const id = typeof value === 'string' ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= FC_MARKET_MIN && id < FC_MARKET_MAX;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000 ? value : null;
}

function time(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  // EDDN переотправляет сообщения из очереди: дата из будущего — мусор.
  if (!Number.isFinite(ms) || ms > Date.now() + 60_000 || ms < Date.UTC(2014, 0, 1)) return null;
  return new Date(ms).toISOString();
}

/**
 * Разобрать сообщение EDDN `journal/1` в строку реестра.
 *
 * Возвращает `null` для всего, что не о носителе: обычные `Docked`/`FSDJump`
 * идут своим путём, а сообщения без MarketID носителя нам не нужны.
 *
 * Поля EDDN отличаются от журнала: система называется `StarSystem`, а не
 * `systemName`; координаты — `StarPos`. `StationName` — позывной.
 */
export function eddnCarrierRow(message: unknown): CarrierRegistryRow | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  if (String(msg.event ?? '') !== 'CarrierJump') return null;
  const marketId = msg.MarketID ?? msg.marketId;
  if (!isCarrierMarketId(marketId)) return null;
  const at = time(msg.timestamp);
  if (!at) return null;
  const system = text(msg.StarSystem ?? msg.systemName ?? msg.SystemName, 120);
  if (!system) return null;
  const pos = Array.isArray(msg.StarPos) ? msg.StarPos : [];
  const services = Array.isArray(msg.StationServices)
    ? Array.from(new Set(msg.StationServices
      .map((entry) => text(entry, 60)?.toLowerCase() ?? '')
      .filter(Boolean))).slice(0, 80)
    : null;
  const stationName = text(msg.StationName, 120);
  return {
    carrier_id: String(marketId),
    // Имя станции у носителя — позывной. Если это не позывной, всё равно
    // в `callsign` не пишем: EDDN не источник имён, а испортить позывной
    // чужим текстом хуже, чем оставить пусто.
    callsign: stationName && isCarrierCallsign(stationName) ? stationName.toUpperCase() : null,
    carrier_type: 'FleetCarrier',
    system_name: system,
    system_address: typeof msg.SystemAddress === 'number' && Number.isSafeInteger(msg.SystemAddress)
      ? msg.SystemAddress
      : null,
    body_name: text(msg.Body, 120),
    x: finite(pos[0]),
    y: finite(pos[1]),
    z: finite(pos[2]),
    services,
    observed_at: at,
  };
}

/**
 * Очередь прыжков авианосцев для живого слушателя EDDN.
 *
 * Ключ — MarketID, а не система: за минуту в одной системе могут прыгнуть
 * несколько носителей, и «последний на систему» потерял бы остальные.
 * Хранится последний прыжок каждого носителя; при переполнении вытесняется
 * самый старый по времени наблюдения.
 */
export function rememberCarrierJump(
  queue: Map<string, { event: Record<string, unknown>; at: number }>,
  event: Record<string, unknown>,
  options: { limit?: number; nowMs?: number } = {},
): boolean {
  const marketId = event?.MarketID;
  if (String(event?.event ?? '') !== 'CarrierJump' || !isCarrierMarketId(marketId)) return false;
  const at = Date.parse(String(event.timestamp ?? ''));
  if (!Number.isFinite(at)) return false;
  const id = String(marketId);
  const current = queue.get(id);
  if (current && current.at > at) return false;
  queue.set(id, { event, at });
  const limit = Math.max(1, options.limit ?? 10_000);
  if (queue.size > limit) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, value] of queue) {
      if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key; }
    }
    if (oldestKey != null) queue.delete(oldestKey);
  }
  return true;
}

/**
 * Визиты из журнала пилота: `Docked`, `Location` (с `Docked: true`) и
 * `CarrierJump` на носителе. Стыковка к чужому Javelin тоже считается: пилот
 * действительно видел носитель, а имя в игре видно в списке станций.
 */
export function carrierVisitsFromJournal(events: unknown): CarrierVisitRow[] {
  if (!Array.isArray(events)) return [];
  const seen = new Map<string, string>();
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const name = String(event.event ?? '');
    if (!['Docked', 'Location', 'CarrierJump'].includes(name)) continue;
    if (name === 'Location' && event.Docked !== true) continue;
    const marketId = event.MarketID ?? event._MarketID;
    if (!isCarrierMarketId(marketId)) continue;
    const at = time(event.timestamp);
    if (!at) continue;
    const id = String(marketId);
    const previous = seen.get(id);
    if (!previous || at > previous) seen.set(id, at);
  }
  return [...seen].map(([carrier_id, observed_at]) => ({ carrier_id, observed_at }));
}

/**
 * Имена из журнала пилота.
 *
 * `CarrierStats`/`CarrierNameChanged` — владелец открыл управление носителем
 * или переименовал его, имя достоверное (`owner`).
 * `Docked`/`CarrierJump` дают имя, только если в `StationName` не позывной:
 * тогда это имя, которое показала игра (`visit`) — слабее, но это слова
 * игрока, а не сторонней базы.
 */
export function carrierNamesFromJournal(events: unknown): Array<{ carrier_id: string; name: string; source: 'owner' | 'visit' }> {
  if (!Array.isArray(events)) return [];
  const names = new Map<string, { name: string; source: 'owner' | 'visit' }>();
  const put = (id: string, name: string | null, source: 'owner' | 'visit') => {
    if (!name) return;
    const clean = normalizeCarrierName(name);
    if (!clean.ok) return;
    const current = names.get(id);
    // Владелец главнее визита, даже если визит обработан позже.
    if (current && current.source === 'owner' && source === 'visit') return;
    names.set(id, { name: clean.name, source });
  };

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    switch (String(event.event ?? '')) {
      case 'CarrierStats':
      case 'CarrierNameChanged':
      case 'CarrierNameChange': {
        const id = event.CarrierID;
        if (id == null) break;
        put(String(id), text(event.Name, 120), 'owner');
        break;
      }
      case 'Docked':
      case 'CarrierJump':
      case 'Location': {
        if (String(event.event) === 'Location' && event.Docked !== true) break;
        const marketId = event.MarketID ?? event._MarketID;
        if (!isCarrierMarketId(marketId)) break;
        const stationName = text(event.StationName, 120);
        // Позывной именем не считаем — иначе «K7Q-BQL» навсегда затрёт имя.
        if (stationName && isCarrierCallsign(stationName)) break;
        put(String(marketId), stationName, 'visit');
        break;
      }
      default:
        break;
    }
  }
  return [...names].map(([carrier_id, value]) => ({ carrier_id, ...value }));
}

/** Проверка имени перед сохранением: обрезаем пробелы, ограничиваем длину. */
export function normalizeCarrierName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { ok: false, error: 'empty' };
  if (name.length > CARRIER_NAME_MAX) return { ok: false, error: 'too_long' };
  // Позывной — не имя: он и так есть отдельной колонкой.
  if (isCarrierCallsign(name)) return { ok: false, error: 'callsign' };
  return { ok: true, name };
}

/** Строка реестра для интерфейса (camelCase, как остальной Атлас). */
export interface CarrierRegistryEntry {
  id: string;
  callsign: string | null;
  name: string | null;
  system: string;
  systemAddress: number | null;
  position: { x: number; y: number; z: number } | null;
  services: string[];
  updatedAt: string;
  sightings: number;
}

export function registryEntryFromRow(row: Record<string, unknown>): CarrierRegistryEntry {
  const coords = [row.x, row.y, row.z].map((value) => (typeof value === 'number' ? value : Number(value)));
  const hasCoords = coords.every((value) => Number.isFinite(value));
  return {
    id: String(row.carrier_id ?? ''),
    callsign: (row.callsign as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    system: (row.system_name as string | null) ?? '',
    systemAddress: row.system_address == null ? null : Number(row.system_address),
    position: hasCoords ? { x: coords[0], y: coords[1], z: coords[2] } : null,
    services: Array.isArray(row.services) ? (row.services as string[]) : [],
    updatedAt: String(row.updated_at ?? ''),
    sightings: Number(row.sightings ?? 0),
  };
}

/**
 * Слияние реестра EDDN и учёта сайта по MarketID.
 *
 * Всё, что сайт знает сам (`fleet_carriers`: владелец, эскадрилья, приватность,
 * груз), главнее: реестр лишь добавляет «этот носитель вообще существует».
 * Имя берётся оттуда, где оно есть: сначала учёт (его уточнил человек в игре),
 * затем реестр (уточнение в Атласе).
 */
export function mergeDirectoryEntry<T extends { id: string; callsign: string | null; name: string | null; system: string }>(
  ours: T | undefined,
  registry: CarrierRegistryEntry | undefined,
): T | null {
  if (ours && registry) {
    if (!ours.callsign && registry.callsign) return { ...ours, callsign: registry.callsign };
    if (!ours.system && registry.system) return { ...ours, system: registry.system };
    return ours;
  }
  return ours ?? null;
}
