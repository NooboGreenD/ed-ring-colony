/**
 * Чтение и запись минорных фракций для API.
 *
 *   * `loadBgsLayer` — слой «все населённые системы» (`GET /api/factions/systems`)
 *     в компактном формате (`encodeBgsLayer`). Десятки тысяч систем — несколько
 *     мегабайт JSON, поэтому собранный набор держится в памяти процесса: до
 *     следующего импорта дампа, но не дольше 10 минут, а после обновлений от
 *     пилотов — пересобирается не чаще раза в минуту;
 *   * `searchBgsFactions`, `readBgsPresence`, `readBgsSystem` — поиск фракций,
 *     системы выбранных фракций и карточка системы (живые запросы к базе);
 *   * `applyPilotSnapshots` — наблюдения из журналов пилотов (Colonial Helper и
 *     загрузчик на сайте) → `bgs_apply_snapshots` и строка в `bgs_updates`.
 */

import { createHash } from 'node:crypto';

import {
  EMPTY_BGS_META,
  encodeBgsLayer,
  snapshotToRpcRow,
  type BgsLayerMeta,
  type BgsLayerRow,
  type BgsSnapshot,
} from './bgs.ts';
import { publicBgsProgress } from './bgsProgress.ts';
import {
  bgsJournalGeneration,
  bgsLayerGeneration,
  bumpBgsJournalGeneration,
  getBgsLiveRun,
  isBgsSyncRunning,
  readBgsSyncState,
} from './bgsSync.ts';

type Svc = any;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Наблюдений пилота в одном вызове `bgs_apply_snapshots`. */
const PILOT_CHUNK = 100;
/** После обновлений от пилотов слой пересобирается не чаще. */
const JOURNAL_REBUILD_MS = 60 * 1000;

interface CachedLayer {
  key: string;
  journalGeneration: number;
  builtAt: number;
  count: number;
  /** Готовая часть ответа: `"allegiances":…,"systems":[…]`. */
  bodyTail: string;
  oldest: string | null;
  newest: string | null;
}

type StoreGlobal = typeof globalThis & { edrcBgsLayerCache?: CachedLayer | null };
const shared = globalThis as StoreGlobal;

export function resetBgsLayerCache(): void {
  shared.edrcBgsLayerCache = null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function rowsFromRpc(value: unknown): BgsLayerRow[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? JSON.parse(value) : [];
  const rows: BgsLayerRow[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!Array.isArray(item)) continue;
    const [id64, name, x, y, z, allegiance, government, controllingId, controlling, population, factionsCount, observed, source] = item as unknown[];
    const px = num(x);
    const py = num(y);
    const pz = num(z);
    if (typeof name !== 'string' || px == null || py == null || pz == null) continue;
    rows.push({
      id64: id64 == null ? '' : String(id64),
      name,
      x: px,
      y: py,
      z: pz,
      allegiance: typeof allegiance === 'string' ? allegiance : null,
      government: typeof government === 'string' ? government : null,
      controllingId: num(controllingId),
      controlling: typeof controlling === 'string' ? controlling : null,
      population: num(population),
      factionsCount: Math.max(0, num(factionsCount) ?? 0),
      observedSec: num(observed),
      source: typeof source === 'string' ? source : null,
    });
  }
  return rows;
}

async function buildLayer(svc: Svc, key: string, journalGeneration: number): Promise<CachedLayer> {
  const { data, error } = await svc.rpc('bgs_layer_rows');
  if (error) throw new Error(error.message);
  const rows = rowsFromRpc(data);
  const encoded = encodeBgsLayer(rows);
  let oldest = Infinity;
  let newest = -Infinity;
  for (const row of rows) {
    if (row.observedSec == null) continue;
    if (row.observedSec < oldest) oldest = row.observedSec;
    if (row.observedSec > newest) newest = row.observedSec;
  }
  const bodyTail = `"allegiances":${JSON.stringify(encoded.allegiances)},"governments":${JSON.stringify(encoded.governments)},`
    + `"sources":${JSON.stringify(encoded.sources)},"factions":${JSON.stringify(encoded.factions)},"systems":${JSON.stringify(encoded.systems)}`;
  return {
    key,
    journalGeneration,
    builtAt: Date.now(),
    count: rows.length,
    bodyTail,
    oldest: Number.isFinite(oldest) ? new Date(oldest * 1000).toISOString() : null,
    newest: Number.isFinite(newest) ? new Date(newest * 1000).toISOString() : null,
  };
}

/** Ошибка импорта для пользователя: без адресов и стеков, коротко. */
function publicError(error: string | null): string | null {
  if (!error) return null;
  if (/HTTP\s+\d+/i.test(error)) return `Источник недоступен (${/HTTP\s+\d+/i.exec(error)![0]})`;
  if (/места на диске/i.test(error)) return 'На сервере не хватило места для дампа';
  if (/abort|timeout|timed out/i.test(error)) return 'Источник не ответил вовремя';
  if (/fetch failed|ENOTFOUND|ECONNRE|EAI_AGAIN|network|обрыв/i.test(error)) return 'Нет связи с источником данных';
  if (/подозрительно мал|сбой источника/i.test(error)) return 'Свежий дамп источника выглядит неполным — обновление отложено';
  if (/останов/i.test(error)) return 'Последнее обновление остановлено вручную';
  return 'Не удалось обновить данные';
}

export interface BgsLayerResult {
  body: string;
  etag: string;
  status: 'ready' | 'empty';
  refreshing: boolean;
  count: number;
  bytes: number;
}

async function lastPilotUpdate(svc: Svc): Promise<string | null> {
  try {
    const { data, error } = await svc
      .from('bgs_updates')
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || !data[0]) return null;
    return typeof data[0].received_at === 'string' ? data[0].received_at : null;
  } catch {
    return null;
  }
}

export async function loadBgsLayer(
  svc: Svc,
  options: { nowMs?: number; metaOnly?: boolean } = {},
): Promise<BgsLayerResult> {
  const nowMs = options.nowMs ?? Date.now();
  const state = await readBgsSyncState(svc);
  const key = `${state.run_id ?? 'none'}:${bgsLayerGeneration()}`;
  const journalGeneration = bgsJournalGeneration();
  let cached = shared.edrcBgsLayerCache ?? null;
  const expired = !cached
    || cached.key !== key
    || nowMs - cached.builtAt > CACHE_TTL_MS
    || (cached.journalGeneration !== journalGeneration && nowMs - cached.builtAt > JOURNAL_REBUILD_MS);
  // Короткий ответ (вкладка следит за идущим импортом) слой не пересобирает:
  // хватает того, что уже в памяти, или счётчиков из состояния импорта.
  if (expired && !options.metaOnly) {
    cached = await buildLayer(svc, key, journalGeneration);
    shared.edrcBgsLayerCache = cached;
  }
  const layer = cached;
  const count = layer?.count ?? state.systems_total;
  const refreshing = isBgsSyncRunning();
  const status = count > 0 ? 'ready' : 'empty';
  const meta: BgsLayerMeta = {
    ...EMPTY_BGS_META,
    dumpGeneratedAt: state.dump_generated_at,
    syncedAt: state.synced_at,
    checkedAt: state.checked_at,
    systems: count,
    factions: state.factions_total,
    presence: state.presence_total,
    oldestObservation: layer?.oldest ?? null,
    newestObservation: layer?.newest ?? null,
    pilotUpdateAt: await lastPilotUpdate(svc),
    refreshing,
    progress: refreshing ? publicBgsProgress(getBgsLiveRun()?.progress) : null,
    lastError: state.status === 'error' ? publicError(state.error) : null,
  };
  const version = `${state.run_id ?? 'none'}.${layer?.journalGeneration ?? journalGeneration}`;
  const metaJson = JSON.stringify(meta);
  if (options.metaOnly || !layer) {
    const body = `{"status":${JSON.stringify(status)},"version":${JSON.stringify(version)},"meta":${metaJson}}`;
    return { body, etag: `"bgs-meta-${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`, status, refreshing, count, bytes: Buffer.byteLength(body) };
  }
  const body = `{"status":${JSON.stringify(status)},"version":${JSON.stringify(version)},"meta":${metaJson},${layer.bodyTail}}`;
  const etag = `"bgs-${createHash('sha1').update(`${layer.key}|${layer.journalGeneration}|${layer.builtAt}|${metaJson}`).digest('hex').slice(0, 20)}"`;
  return { body, etag, status, refreshing, count, bytes: Buffer.byteLength(body) };
}

/* ── Поиск, присутствие, карточка ──────────────────────────────────────── */

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function searchBgsFactions(svc: Svc, query: string, options: { limit?: number; player?: boolean } = {}): Promise<unknown[]> {
  const { data, error } = await svc.rpc('bgs_search_factions', {
    p_query: query.slice(0, 80),
    p_limit: Math.max(1, Math.min(50, options.limit ?? 20)),
    p_player: options.player === true,
  });
  if (error) throw new Error(error.message);
  const list = parseJson(data);
  return Array.isArray(list) ? list : [];
}

export async function readBgsPresence(svc: Svc, ids: number[]): Promise<unknown[]> {
  if (ids.length === 0) return [];
  const { data, error } = await svc.rpc('bgs_faction_presence_rows', { p_ids: ids });
  if (error) throw new Error(error.message);
  const list = parseJson(data);
  return Array.isArray(list) ? list : [];
}

/**
 * `id64` системы по её имени: та же нормализация, что у колонки `name_lc`
 * (`lower(btrim(name))` в миграции 20261019120000_minor_factions.sql).
 *
 * Нужна там, где адреса системы нет: Helper знает только имя из журнала, а
 * карточка системы строится по `id64`. `null` — системы в данных о фракциях
 * нет (ненаселённая или ещё не приходила ни от пилотов, ни из дампа EDSM).
 */
export async function findBgsSystemIdByName(svc: Svc, name: string): Promise<string | null> {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key) return null;
  const { data, error } = await svc
    .from('bgs_systems')
    .select('id64')
    .eq('name_lc', key)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const id = (data as { id64?: unknown } | null)?.id64;
  if (id === null || id === undefined) return null;
  return String(id);
}

export async function readBgsSystem(svc: Svc, id64: string): Promise<{ system: unknown; factions: unknown[] } | null> {
  const { data, error } = await svc.rpc('bgs_system_detail', { p_id64: id64 });
  if (error) throw new Error(error.message);
  const value = parseJson(data) as { system?: unknown; factions?: unknown } | null;
  if (!value || !value.system) return null;
  return { system: value.system, factions: Array.isArray(value.factions) ? value.factions : [] };
}

/* ── Обновления от пилотов ─────────────────────────────────────────────── */

export interface PilotApplyResult {
  received: number;
  applied: number;
  stale: number;
  created: number;
  systems: string[];
}

/** Наблюдения пилота → база; заодно строка в журнале обновлений для админки. */
export async function applyPilotSnapshots(
  svc: Svc,
  snapshots: BgsSnapshot[],
  meta: { source: 'helper' | 'web' | 'eddn'; userId: string | null; invalid: number },
): Promise<PilotApplyResult> {
  const result: PilotApplyResult = { received: 0, applied: 0, stale: 0, created: 0, systems: [] };
  // Пачками по PILOT_CHUNK: каждый вызов должен уложиться в statement_timeout PostgREST.
  for (let offset = 0; offset < snapshots.length; offset += PILOT_CHUNK) {
    const { data, error } = await svc.rpc('bgs_apply_snapshots', {
      p_rows: snapshots.slice(offset, offset + PILOT_CHUNK).map(snapshotToRpcRow),
      p_source: meta.source,
      p_run: null,
      p_recount: true,
    });
    if (error) throw new Error(error.message);
    const raw = (parseJson(data) ?? {}) as Record<string, unknown>;
    result.received += Number(raw.received ?? 0) || 0;
    result.applied += Number(raw.applied ?? 0) || 0;
    result.stale += Number(raw.stale ?? 0) || 0;
    result.created += Number(raw.created ?? 0) || 0;
    for (const name of Array.isArray(raw.systems) ? raw.systems : []) {
      if (typeof name === 'string' && result.systems.length < 20) result.systems.push(name);
    }
  }
  // Новые системы или смена власти меняют слой — пересобрать его позже.
  if (result.applied > 0) bumpBgsJournalGeneration();
  try {
    await svc.from('bgs_updates').insert({
      user_id: meta.userId,
      source: meta.source,
      received: result.received + meta.invalid,
      applied: result.applied,
      stale: result.stale,
      created: result.created,
      invalid: meta.invalid,
      systems: result.systems.slice(0, 12),
    });
    // Журнал обновлений — за последние 30 дней.
    if (Math.random() < 0.05) {
      await svc.from('bgs_updates').delete().lt('received_at', new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
    }
  } catch {
    // Журнал обновлений — для админки; без него данные всё равно записаны.
  }
  return result;
}
