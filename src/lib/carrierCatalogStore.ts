/**
 * Серверная часть каталога авианосцев (`/carriers`).
 *
 * Вся тяжёлая работа — в SQL-функции `carrier_catalog_page` (миграция
 * `20261116090000_carrier_catalog.sql`): она объединяет учёт сайта и реестр
 * EDDN, ищет по склеенному полю, фильтрует, сортирует и считает общее число
 * совпадений. Здесь — только подготовка аргументов и приведение строк к виду,
 * который понимает таблица (`catalogRowFromRow`).
 *
 * Почему фильтр «мои» считается на сервере: иначе он отбирал бы строки уже
 * после пагинации, и «страница 2» показывала бы дырки. Эскадрильи зрителя
 * берутся из `viewerContext` — того же места, что у карточки носителя и карты.
 *
 * Владельца и его имя каталог не отдаёт вовсе: в списке видно только
 * отношение (`own`/`squadron`/`other`). Имя владельца остаётся в карточке
 * носителя, где решается по настройкам приватности.
 */

import { viewerContext } from './fleetCarrierStore.ts';
import {
  CARRIER_CATALOG_MAX_PAGE_SIZE,
  CARRIER_CATALOG_PAGE_SIZE,
  catalogClampPage,
  catalogPageCount,
  catalogPageNumber,
  catalogRowFromRow,
  normalizeCatalogSearch,
  type CarrierCatalogJump,
  type CarrierCatalogOrigin,
  type CarrierCatalogRow,
  type CarrierCatalogScope,
  type CarrierCatalogSort,
} from './carrierCatalog.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

export interface CarrierCatalogRequest {
  q?: string | null;
  origin?: CarrierCatalogOrigin | string | null;
  scope?: CarrierCatalogScope | string | null;
  jump?: CarrierCatalogJump | string | null;
  sort?: CarrierCatalogSort | string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
}

export interface CarrierCatalogPage {
  rows: CarrierCatalogRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

function originOf(value: unknown): 'site' | 'eddn' | null {
  const raw = String(value ?? '').toLowerCase();
  return raw === 'site' || raw === 'eddn' ? raw : null;
}

function sortOf(value: unknown): CarrierCatalogSort {
  const raw = String(value ?? '').toLowerCase();
  return raw === 'name' || raw === 'system' ? raw : 'recent';
}

function pageSizeOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return CARRIER_CATALOG_PAGE_SIZE;
  return Math.max(1, Math.min(CARRIER_CATALOG_MAX_PAGE_SIZE, Math.floor(number)));
}

/**
 * Одна страница каталога.
 *
 * `page` из адреса может указывать за конец списка (фильтр сузили) — тогда
 * отдаётся последняя существующая страница, а не пустая таблица: иначе пилот
 * видел бы «ничего не найдено» при тысяче совпадений.
 */
export async function loadCarrierCatalogPage(
  svc: Svc,
  viewerId: string | null,
  request: CarrierCatalogRequest = {},
  options: { now?: Date } = {},
): Promise<CarrierCatalogPage> {
  const now = options.now ?? new Date();
  const pageSize = pageSizeOf(request.pageSize);
  const scope = String(request.scope ?? '').toLowerCase() === 'mine' && viewerId ? 'mine' : null;
  const search = normalizeCatalogSearch(request.q) || null;
  const base = {
    search,
    origin: originOf(request.origin),
    scope,
    viewerId,
    // Эскадрильи нужны и фильтру «мои», и подписи отношения в строках.
    squadrons: viewerId
      ? (await viewerContext(svc, viewerId).catch(() => ({ squadronIds: [] as number[] }))).squadronIds
      : [],
    jump: String(request.jump ?? '').toLowerCase() === 'planned',
    sort: sortOf(request.sort),
    limit: pageSize,
  } as const;

  let page = catalogPageNumber(request.page);
  let payload = await readPage(svc, { ...base, offset: (page - 1) * pageSize });
  const total = Math.max(0, Math.floor(Number(payload.total) || 0));
  const pages = catalogPageCount(total, pageSize);
  const clamped = catalogClampPage(page, pages);
  // Из адреса легко прийти на «страницу 99»: тогда читаем последнюю
  // существующую, а не отдаём пустую таблицу при тысяче совпадений.
  if (clamped !== page) {
    page = clamped;
    payload = await readPage(svc, { ...base, offset: (page - 1) * pageSize });
  }

  const rows = (Array.isArray(payload.rows) ? payload.rows : [])
    .map((row: Record<string, unknown>) => catalogRowFromRow(row, now.getTime()))
    .filter((row: CarrierCatalogRow | null): row is CarrierCatalogRow => row != null);

  return { rows, total, page, pageSize, pages };
}

interface ReadPageInput {
  search: string | null;
  origin: 'site' | 'eddn' | null;
  scope: 'mine' | null;
  viewerId: string | null;
  squadrons: number[];
  jump: boolean;
  sort: CarrierCatalogSort;
  offset: number;
  limit: number;
}

async function readPage(
  svc: Svc,
  input: ReadPageInput,
): Promise<{ total?: number; rows?: Record<string, unknown>[] }> {
  const { data, error } = await svc.rpc('carrier_catalog_page', {
    p_search: input.search,
    p_origin: input.origin,
    p_scope: input.scope,
    p_user: input.viewerId,
    p_squadrons: input.squadrons,
    p_jump: input.jump,
    p_sort: input.sort,
    p_offset: input.offset,
    p_limit: input.limit,
  });
  if (error) throw new Error(error.message ?? String(error));
  const payload = typeof data === 'string' ? JSON.parse(data) : data;
  return (payload ?? {}) as { total?: number; rows?: Record<string, unknown>[] };
}
