/**
 * Запись кусков дампа фракций в базу.
 *
 * Как у импорта каталога систем (`galaxyImportJob.ts`): если веб-процессу
 * задан прямой Postgres (`DATABASE_URL` / `SUPABASE_DB_URL` — деплой собирает
 * его сам, см. deploy/start-monitoring.sh), кусок в тысячу систем уходит
 * одним вызовом `bgs_apply_snapshots` без `statement_timeout`, а завершение
 * (удаление пропавших систем, пересчёт фракций) — одним запросом на шаг.
 * Нет прямого подключения или оно не поднялось — тот же SQL через PostgREST:
 * пачками по 250 систем, пачка, не уложившаяся в короткий
 * `statement_timeout`, делится пополам; завершение — короткими шагами.
 *
 * `FACTIONS_DB_DIRECT=0` выключает прямой путь (на случай, если с ним что-то
 * не так на конкретном сервере).
 */

import { connectPgClient, galaxyDbUrl, isPgConnectionError, pgConnectionTarget } from './pgModule.ts';

type Svc = any;

export type BgsWriterBackend = 'pg' | 'postgrest';

/** Систем в пачке записи через PostgREST: ≈1,5 КБ JSON каждая. */
export const BGS_BATCH_SIZE = 250;
/** Систем в одном вызове при прямом подключении (кусок целиком). */
export const BGS_PG_BATCH_SIZE = 1000;
/** Завершение через PostgREST короткими вызовами: столько строк / id за раз (делится пополам при таймауте). */
const DELETE_STEP = 2000;
const RECOUNT_STEP = 5000;
const PRUNE_STEP = 5000;
/** То же при прямом подключении — шаг большой, таймаута нет. */
const PG_STEP = 100_000;
const CONFLICT_RETRIES = 4;

export interface BgsApplyResult {
  applied: number;
  stale: number;
  /** Вызовов базы (пачек). */
  calls: number;
}

export interface BgsDbWriter {
  backend: BgsWriterBackend;
  /** Систем в одном вызове записи. */
  batchSize: number;
  /** Для журнала: «прямой Postgres (db:5432)» / «PostgREST». */
  label: string;
  apply(rows: Record<string, unknown>[], runId: string): Promise<BgsApplyResult>;
  deleteMissing(runId: string, keepDays: number): Promise<number>;
  recountAll(onStep?: (done: number) => void | Promise<void>): Promise<number>;
  prune(): Promise<number>;
  finish(runId: string, state: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Нужное от клиента Postgres: настоящий `pg.Client` и тестовый PGlite подходят оба. */
export interface BgsPgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

type LogFn = (level: 'info' | 'warn' | 'error', text: string) => void;

export function bgsBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.max(20, Math.min(1000, Math.floor(raw))) : BGS_BATCH_SIZE;
}

/** `FACTIONS_DB_DIRECT=0` — писать только через PostgREST, даже если прямой Postgres задан. */
export function bgsDirectDb(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.FACTIONS_DB_DIRECT?.trim() ?? '');
}

/** Какой путь записи выберет импорт (для админки, без подключения). */
export function describeBgsWriter(env: NodeJS.ProcessEnv = process.env): { backend: BgsWriterBackend; host: string | null; disabled: boolean } {
  const url = galaxyDbUrl(env);
  const direct = bgsDirectDb(env);
  return {
    backend: url && direct ? 'pg' : 'postgrest',
    host: url ? pgConnectionTarget(url)?.host ?? null : null,
    disabled: Boolean(url) && !direct,
  };
}

/** PostgREST оборвал запрос по statement_timeout (57014): пачку надо уменьшить. */
export function isStatementTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === '57014' || /statement timeout|canceling statement/i.test(String(e?.message ?? ''));
}

/** Взаимная блокировка с записью пилотов (40P01) или конфликт сериализации: повторить. */
export function isWriteConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === '40P01' || e?.code === '40001' || /deadlock detected|could not serialize/i.test(String(e?.message ?? ''));
}

const pause = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

async function withConflictRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= CONFLICT_RETRIES) throw error;
      await pause(150 * 2 ** attempt);
    }
  }
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function json(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/* ── PostgREST ─────────────────────────────────────────────────────────── */

/** Повторять вызов, пока он удаляет полную пачку; при таймауте — пачку меньше. */
async function deleteInSteps(
  call: (limit: number) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>,
  label: string,
  start: number,
): Promise<number> {
  let limit = start;
  let total = 0;
  for (;;) {
    const { data, error } = await call(limit);
    if (error) {
      if (isStatementTimeout(error) && limit > 50) {
        limit = Math.max(50, Math.floor(limit / 2));
        continue;
      }
      throw new Error(`${label}: ${error.message}`);
    }
    const removed = count(data);
    total += removed;
    if (removed < limit) return total;
  }
}

/** Счётчики всех фракций — пачками по id, чтобы каждый вызов был коротким. */
export async function recountAllFactions(
  svc: Svc,
  onStep?: (done: number) => void | Promise<void>,
): Promise<number> {
  let after = 0;
  let step = RECOUNT_STEP;
  let changed = 0;
  let done = 0;
  for (;;) {
    const { data, error } = await svc.rpc('bgs_recount_factions_batch', { p_after: after, p_limit: step });
    if (error) {
      if (isStatementTimeout(error) && step > 250) {
        step = Math.max(250, Math.floor(step / 2));
        continue;
      }
      throw new Error(`Пересчёт фракций: ${error.message}`);
    }
    const result = json(data);
    const rows = count(result.rows);
    if (rows === 0) return changed;
    changed += count(result.changed);
    done += rows;
    const last = Number(result.last_id);
    if (!Number.isFinite(last) || last <= after) return changed;
    after = last;
    await onStep?.(done);
  }
}

export function createPostgrestBgsWriter(svc: Svc, options: { batchSize?: number; log?: LogFn } = {}): BgsDbWriter {
  const batchSize = Math.max(1, options.batchSize ?? bgsBatchSize());
  const log = options.log ?? (() => undefined);

  // Пачка, не уложившаяся в statement_timeout PostgREST, делится пополам.
  const callApply = async (rows: Record<string, unknown>[], runId: string) => {
    for (let attempt = 1; ; attempt++) {
      const response = await svc.rpc('bgs_apply_snapshots', { p_rows: rows, p_source: 'edsm', p_run: runId, p_recount: false });
      if (response.error && isWriteConflict(response.error) && attempt < CONFLICT_RETRIES) {
        await pause(150 * 2 ** attempt);
        continue;
      }
      return response as { data: unknown; error: { message: string; code?: string } | null };
    }
  };

  const writeRows = async (rows: Record<string, unknown>[], runId: string): Promise<BgsApplyResult> => {
    const { data, error } = await callApply(rows, runId);
    if (error) {
      if (rows.length > 1 && isStatementTimeout(error)) {
        log('warn', `Пачка из ${rows.length} систем не уложилась в statement_timeout базы — делю пополам`);
        const middle = Math.ceil(rows.length / 2);
        const left = await writeRows(rows.slice(0, middle), runId);
        const right = await writeRows(rows.slice(middle), runId);
        return { applied: left.applied + right.applied, stale: left.stale + right.stale, calls: left.calls + right.calls };
      }
      throw new Error(`Запись фракций в базу: ${error.message}`);
    }
    const result = json(data);
    return { applied: count(result.applied), stale: count(result.stale), calls: 1 };
  };

  return {
    backend: 'postgrest',
    batchSize,
    label: 'PostgREST',
    async apply(rows, runId) {
      const total: BgsApplyResult = { applied: 0, stale: 0, calls: 0 };
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const part = await writeRows(rows.slice(offset, offset + batchSize), runId);
        total.applied += part.applied;
        total.stale += part.stale;
        total.calls += part.calls;
      }
      return total;
    },
    deleteMissing(runId, keepDays) {
      return deleteInSteps(
        (limit) => svc.rpc('bgs_delete_missing', { p_run: runId, p_keep_days: keepDays, p_limit: limit }),
        'Удаление пропавших систем',
        DELETE_STEP,
      );
    },
    recountAll(onStep) {
      return recountAllFactions(svc, onStep);
    },
    prune() {
      return deleteInSteps((limit) => svc.rpc('bgs_prune_factions', { p_limit: limit }), 'Удаление фракций без систем', PRUNE_STEP);
    },
    async finish(runId, state) {
      const { data, error } = await svc.rpc('bgs_finish_sync', { p_run: runId, p_state: state });
      if (error) throw new Error(`Завершение импорта фракций: ${error.message}`);
      return json(data);
    },
    async close() {
      // HTTP-клиент закрывать не нужно
    },
  };
}

/* ── Прямой Postgres ───────────────────────────────────────────────────── */

export function createPgBgsWriter(client: BgsPgClient, options: { batchSize?: number; label?: string } = {}): BgsDbWriter {
  const batchSize = Math.max(1, options.batchSize ?? BGS_PG_BATCH_SIZE);
  const one = async (text: string, values: unknown[]): Promise<unknown> => {
    const result = await withConflictRetry(() => client.query(text, values));
    const row = result.rows?.[0] ?? {};
    return Object.values(row)[0];
  };
  return {
    backend: 'pg',
    batchSize,
    label: options.label ?? 'прямой Postgres',
    async apply(rows, runId) {
      const total: BgsApplyResult = { applied: 0, stale: 0, calls: 0 };
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const part = rows.slice(offset, offset + batchSize);
        const result = json(
          await one('SELECT public.bgs_apply_snapshots($1::jsonb, $2::text, $3::uuid, false) AS result', [JSON.stringify(part), 'edsm', runId]),
        );
        total.applied += count(result.applied);
        total.stale += count(result.stale);
        total.calls += 1;
      }
      return total;
    },
    async deleteMissing(runId, keepDays) {
      let total = 0;
      for (;;) {
        const removed = count(await one('SELECT public.bgs_delete_missing($1::uuid, $2::integer, $3::integer) AS n', [runId, keepDays, PG_STEP]));
        total += removed;
        if (removed < PG_STEP) return total;
      }
    },
    async recountAll(onStep) {
      const changed = count(await one('SELECT public.bgs_recount_factions(NULL) AS n', []));
      await onStep?.(changed);
      return changed;
    },
    async prune() {
      let total = 0;
      for (;;) {
        const removed = count(await one('SELECT public.bgs_prune_factions($1::integer) AS n', [PG_STEP]));
        total += removed;
        if (removed < PG_STEP) return total;
      }
    },
    async finish(runId, state) {
      return json(await one('SELECT public.bgs_finish_sync($1::uuid, $2::jsonb) AS result', [runId, JSON.stringify(state)]));
    },
    async close() {
      await client.end().catch(() => undefined);
    },
  };
}

export interface CreateBgsWriterOptions {
  svc: Svc;
  log?: LogFn;
  /** Строка подключения; по умолчанию DATABASE_URL / SUPABASE_DB_URL. */
  connectionString?: string | null;
  /** По умолчанию `FACTIONS_DB_DIRECT`. */
  direct?: boolean;
  /** Готовый клиент (тесты: PGlite). */
  pgClient?: () => Promise<BgsPgClient>;
  batchSize?: number;
  pgBatchSize?: number;
  /** Попыток подключения к Postgres (тесты — 1). */
  pgAttempts?: number;
}

/**
 * Путь записи для импорта: прямой Postgres, если он задан и отвечает, иначе
 * PostgREST — с объяснением в журнале, почему.
 */
export async function createBgsWriter(options: CreateBgsWriterOptions): Promise<BgsDbWriter> {
  const log = options.log ?? (() => undefined);
  const url = options.connectionString === undefined ? galaxyDbUrl() : options.connectionString;
  const direct = options.direct ?? bgsDirectDb();
  const postgrest = () => createPostgrestBgsWriter(options.svc, { batchSize: options.batchSize, log });

  if (options.pgClient && direct) {
    return createPgBgsWriter(await options.pgClient(), { batchSize: options.pgBatchSize });
  }
  if (!url) {
    log('info', 'Прямой Postgres не задан (DATABASE_URL/SUPABASE_DB_URL) — пишу через PostgREST: медленнее, но для ≈0,5 ГБ дампа хватает');
    return postgrest();
  }
  if (!direct) {
    log('info', 'FACTIONS_DB_DIRECT=0 — прямой Postgres выключен, пишу через PostgREST');
    return postgrest();
  }
  const host = pgConnectionTarget(url);
  const label = `прямой Postgres${host ? ` (${host.host}${host.port ? `:${host.port}` : ''})` : ''}`;
  try {
    const client = await connectPgClient({
      connectionString: url,
      statementTimeoutMs: 0,
      queryTimeoutMs: 0,
      connectionTimeoutMillis: 15_000,
      attempts: options.pgAttempts ?? 2,
      log: (line) => log('warn', line),
    });
    const queryable = client as unknown as BgsPgClient;
    return createPgBgsWriter({ query: (text, values) => queryable.query(text, values), end: () => client.end() }, { batchSize: options.pgBatchSize, label });
  } catch (error) {
    const detail = isPgConnectionError(error) ? error.failure.message : (error as Error)?.message || String(error);
    log('warn', `Прямой Postgres недоступен — ${detail.slice(0, 300)}. Пишу через PostgREST`);
    return postgrest();
  }
}
