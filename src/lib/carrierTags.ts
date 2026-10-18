/**
 * Тег эскадрильи у эскадренного авианосца (Javelin-Class).
 *
 * Позывной Javelin — это тег его эскадрильи в игре: четыре латинские буквы или
 * цифры («ENEX» у ENDURANCE EXPLORATION). Его видит любой пилот: `StationName`
 * в `Docked`/`Location`/`CarrierJump`, сигнал FSS («ENDURANCE ENDEAVOUR | ENEX»),
 * `CarrierStats.Callsign` у офицеров. У личного Drake-Class позывной другой —
 * «K7X-B0Z».
 *
 * Тег — единственное, что журнал говорит о принадлежности чужого Javelin, и он
 * не даёт прав: по тегу сайт только отказывается приписать носитель не той
 * эскадрилье (тег носителя ≠ тегу эскадрильи на сайте) и подписывает носитель
 * на карте. Привязку с доступом к грузу дают лишь события, которые игра пишет
 * членам эскадрильи (см. `SQUADRON_PROOF_EVENTS` в fleetCarriers.ts).
 *
 * Те же правила — в SQL (`fleet_carrier_tag_conflict`, миграция
 * 20261018000000_fleet_carrier_squadron_claims.sql). Модуль без зависимостей:
 * его импортируют сервер, клиентская карта и тесты (`node --test`).
 */

const GAME_TAG = /^[A-Z0-9]{4}$/;

/** Тег в сравнимом виде: латиница и цифры в верхнем регистре, без скобок и пробелов. */
export function normalizeSquadronTag(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
}

/**
 * Тег эскадрильи сайта, если он может быть игровым (ровно четыре символа).
 * Тег другой длины ничего не доказывает: его могли собрать из названия.
 */
export function gameSquadronTag(value: unknown): string | null {
  const tag = normalizeSquadronTag(value);
  return GAME_TAG.test(tag) ? tag : null;
}

/** Позывной эскадренного носителя: ровно четыре латинские буквы или цифры. */
export function looksLikeSquadronCallsign(value: unknown): boolean {
  return typeof value === 'string' && GAME_TAG.test(value.trim().toUpperCase());
}

/** Тег эскадрильи носителя из его позывного — только у Javelin. */
export function carrierSquadronTag(carrier: { type?: string | null; callsign?: string | null }): string | null {
  if (carrier.type !== 'SquadronCarrier' || !looksLikeSquadronCallsign(carrier.callsign)) return null;
  return String(carrier.callsign).trim().toUpperCase();
}

/** Тег носителя противоречит тегу эскадрильи сайта: оба известны и не совпадают. */
export function squadronTagConflict(callsign: unknown, squadronTag: unknown): boolean {
  if (!looksLikeSquadronCallsign(callsign)) return false;
  const site = gameSquadronTag(squadronTag);
  return site != null && site !== String(callsign).trim().toUpperCase();
}
