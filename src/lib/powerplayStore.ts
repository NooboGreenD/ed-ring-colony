/**
 * Ответ `GET /api/powerplay/systems`: системы под контролем держав в
 * компактном формате (`encodePowerplayLayer`) плюс состояние источника.
 *
 * ~50 тысяч систем — это ~4 МБ JSON, поэтому собранный набор держится в
 * памяти процесса до следующего импорта: каждый запрос читает одну строку
 * состояния и склеивает готовую часть со свежими метаданными. Версия набора —
 * идентификатор импорта; по ней же браузер получает 304.
 */

import { createHash } from 'node:crypto';
import {
  EMPTY_POWERPLAY_META,
  encodePowerplayLayer,
  normalizePowerplayState,
  type PowerplayLayerMeta,
  type PowerplayRow,
} from './powerplay.ts';
import {
  ensurePowerplayFresh,
  powerplayLayerGeneration,
  readPowerplaySyncState,
  type PowerplaySyncOptions,
} from './powerplaySync.ts';

type Svc = any;

/** Сколько держать собранный набор без импорта (на случай записи мимо процесса). */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedLayer {
  key: string;
  builtAt: number;
  count: number;
  /** Готовые JSON-фрагменты: `powers`, `states`, `systems`. */
  powersJson: string;
  statesJson: string;
  systemsJson: string;
  oldest: string | null;
  newest: string | null;
}

type StoreGlobal = typeof globalThis & { edrcPowerplayLayerCache?: CachedLayer | null };
const shared = globalThis as StoreGlobal;

export function resetPowerplayLayerCache(): void {
  shared.edrcPowerplayLayerCache = null;
}

function rowsFromRpc(value: unknown): PowerplayRow[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? JSON.parse(value) : [];
  const rows: PowerplayRow[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!Array.isArray(item)) continue;
    const [id64, name, x, y, z, power, state, observed] = item as unknown[];
    const normalized = normalizePowerplayState(state);
    const px = Number(x);
    const py = Number(y);
    const pz = Number(z);
    if (typeof name !== 'string' || typeof power !== 'string' || !normalized) continue;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
    const seconds = observed == null ? NaN : Number(observed);
    rows.push({
      id64: id64 == null ? '' : String(id64),
      name,
      x: px,
      y: py,
      z: pz,
      power,
      state: normalized,
      observedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
    });
  }
  return rows;
}

async function buildLayer(svc: Svc, key: string): Promise<CachedLayer> {
  const { data, error } = await svc.rpc('powerplay_layer_rows');
  if (error) throw new Error(error.message);
  const rows = rowsFromRpc(data);
  const encoded = encodePowerplayLayer(rows, EMPTY_POWERPLAY_META, key);
  let oldest = Infinity;
  let newest = -Infinity;
  for (const tuple of encoded.systems) {
    const seconds = tuple[7];
    if (seconds == null) continue;
    if (seconds < oldest) oldest = seconds;
    if (seconds > newest) newest = seconds;
  }
  return {
    key,
    builtAt: Date.now(),
    count: encoded.systems.length,
    powersJson: JSON.stringify(encoded.powers),
    statesJson: JSON.stringify(encoded.states),
    systemsJson: JSON.stringify(encoded.systems),
    oldest: Number.isFinite(oldest) ? new Date(oldest * 1000).toISOString() : null,
    newest: Number.isFinite(newest) ? new Date(newest * 1000).toISOString() : null,
  };
}

/** Ошибка импорта для пользователя: без адресов и стеков, коротко. */
function publicError(error: string | null): string | null {
  if (!error) return null;
  if (/HTTP\s+\d+/i.test(error)) return `Источник недоступен (${/HTTP\s+\d+/i.exec(error)![0]})`;
  if (/abort|timeout|timed out/i.test(error)) return 'Источник не ответил вовремя';
  if (/fetch failed|ENOTFOUND|ECONNRE|EAI_AGAIN|network/i.test(error)) return 'Нет связи с источником данных';
  if (/подозрительно мал|сбой источника|не похож/i.test(error)) return 'Свежий дамп источника выглядит неполным — импорт отложен';
  return 'Не удалось обновить данные';
}

export interface PowerplayLayerResult {
  body: string;
  etag: string;
  status: 'ready' | 'empty';
  refreshing: boolean;
  count: number;
}

export async function loadPowerplayLayer(
  svc: Svc,
  options: PowerplaySyncOptions & { nowMs?: number; refresh?: boolean } = {},
): Promise<PowerplayLayerResult> {
  const nowMs = options.nowMs ?? Date.now();
  const state = await readPowerplaySyncState(svc);
  const freshness = options.refresh === false
    ? { refreshing: false, stale: false }
    : ensurePowerplayFresh(svc, state, options);

  const key = `${state.run_id ?? 'none'}:${powerplayLayerGeneration()}`;
  let cached = shared.edrcPowerplayLayerCache ?? null;
  if (!cached || cached.key !== key || nowMs - cached.builtAt > CACHE_TTL_MS) {
    cached = await buildLayer(svc, key);
    shared.edrcPowerplayLayerCache = cached;
  }

  const status = cached.count > 0 ? 'ready' : 'empty';
  const meta: PowerplayLayerMeta = {
    ...EMPTY_POWERPLAY_META,
    sourceUrl: 'https://www.edsm.net/en/nightly-dumps',
    dumpGeneratedAt: state.dump_generated_at,
    syncedAt: state.synced_at,
    checkedAt: state.checked_at,
    oldestObservation: cached.oldest,
    newestObservation: cached.newest,
    refreshing: freshness.refreshing,
    lastError: state.status === 'error' ? publicError(state.error) : null,
  };
  const version = state.run_id ?? 'none';
  const metaJson = JSON.stringify(meta);
  const body = `{"status":${JSON.stringify(status)},"version":${JSON.stringify(version)},"meta":${metaJson},`
    + `"powers":${cached.powersJson},"states":${cached.statesJson},"systems":${cached.systemsJson}}`;
  const etag = `"pp-${createHash('sha1').update(`${cached.key}|${metaJson}`).digest('hex').slice(0, 20)}"`;
  return { body, etag, status, refreshing: freshness.refreshing, count: cached.count };
}
