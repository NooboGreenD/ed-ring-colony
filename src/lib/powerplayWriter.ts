/**
 * Запись кусков дампа PowerPlay в базу — как у минорных фракций
 * (`bgsWriter.ts`) и каталога систем.
 *
 * Если веб-процессу задан прямой Postgres (`DATABASE_URL` / `SUPABASE_DB_URL`
 * — деплой собирает его сам), кусок уходит одним вызовом
 * `powerplay_apply_batch` без `statement_timeout`, завершение — одним
 * запросом. Нет прямого подключения или оно не поднялось — тот же SQL через
 * PostgREST: пачками по `POWERPLAY_BATCH_SIZE` (2000) систем, пачка, не
 * уложившаяся в короткий `statement_timeout`, делится пополам.
 *
 * `POWERPLAY_DB_DIRECT=0` выключает прямой путь.
 */

import { isStatementTimeout, isWriteConflict, type BgsPgClient } from './bgsWriter.ts';
import { connectPgClient, galaxyDbUrl, isPgConnectionError, pgConnectionTarget } from './pgModule.ts';

type Svc = any;

export type PowerplayWriterBackend = 'pg' | 'postgrest';
export type PowerplayPgClient = BgsPgClient;

/** Систем в пачке записи через PostgREST. */
export const POWERPLAY_BATCH_SIZE = 2000;
const CONFLICT_RETRIES = 4;

export interface PowerplayApplyResult {
  /** Строк, которые база записала (свежие строки пилотов не перетираются). */
  written: number;
  /** Вызовов базы (пачек). */
  calls: number;
}

export interface PowerplayDbWriter {
  backend: PowerplayWriterBackend;
  /** Систем в одном вызове записи (0 — кусок целиком). */
  batchSize: number;
  /** Для журнала: «прямой Postgres (db:5432)» / «PostgREST». */
  label: string;
  apply(rows: Record<string, unknown>[], runId: string): Promise<PowerplayApplyResult>;
  finish(runId: string, state: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

type LogFn = (level: 'info' | 'warn' | 'error', text: string) => void;

export function powerplayBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.POWERPLAY_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.max(50, Math.min(5000, Math.floor(raw))) : POWERPLAY_BATCH_SIZE;
}

/** `POWERPLAY_DB_DIRECT=0` — писать только через PostgREST, даже если прямой Postgres задан. */
export function powerplayDirectDb(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.POWERPLAY_DB_DIRECT?.trim() ?? '');
}

/** Какой путь записи выберет импорт (для админки, без подключения). */
export function describePowerplayWriter(env: NodeJS.ProcessEnv = process.env): { backend: PowerplayWriterBackend; host: string | null; disabled: boolean } {
  const url = galaxyDbUrl(env);
  const direct = powerplayDirectDb(env);
  return {
    backend: url && direct ? 'pg' : 'postgrest',
    host: url ? pgConnectionTarget(url)?.host ?? null : null,
    disabled: Boolean(url) && !direct,
  };
}

const pause = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function json(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/* ── PostgREST ─────────────────────────────────────────────────────────── */

export function createPostgrestPowerplayWriter(svc: Svc, options: { batchSize?: number; log?: LogFn } = {}): PowerplayDbWriter {
  const batchSize = Math.max(1, options.batchSize ?? powerplayBatchSize());
  const log = options.log ?? (() => undefined);

  const callApply = async (rows: Record<string, unknown>[], runId: string) => {
    for (let attempt = 1; ; attempt++) {
      const response = await svc.rpc('powerplay_apply_batch', { p_run: runId, p_rows: rows });
      if (response.error && isWriteConflict(response.error) && attempt < CONFLICT_RETRIES) {
        await pause(150 * 2 ** attempt);
        continue;
      }
      return response as { data: unknown; error: { message: string; code?: string } | null };
    }
  };

  // Пачка, не уложившаяся в statement_timeout PostgREST, делится пополам.
  const writeRows = async (rows: Record<string, unknown>[], runId: string): Promise<PowerplayApplyResult> => {
    const { data, error } = await callApply(rows, runId);
    if (error) {
      if (rows.length > 1 && isStatementTimeout(error)) {
        log('warn', `Пачка из ${rows.length} систем не уложилась в statement_timeout базы — делю пополам`);
        const middle = Math.ceil(rows.length / 2);
        const left = await writeRows(rows.slice(0, middle), runId);
        const right = await writeRows(rows.slice(middle), runId);
        return { written: left.written + right.written, calls: left.calls + right.calls };
      }
      throw new Error(`Запись систем PowerPlay в базу: ${error.message}`);
    }
    return { written: count(data), calls: 1 };
  };

  return {
    backend: 'postgrest',
    batchSize,
    label: 'PostgREST',
    async apply(rows, runId) {
      const total: PowerplayApplyResult = { written: 0, calls: 0 };
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const part = await writeRows(rows.slice(offset, offset + batchSize), runId);
        total.written += part.written;
        total.calls += part.calls;
      }
      return total;
    },
    async finish(runId, state) {
      const { data, error } = await svc.rpc('powerplay_finish_sync', { p_run: runId, p_state: state });
      if (error) throw new Error(`Завершение импорта PowerPlay: ${error.message}`);
      return json(data);
    },
    async close() {
      // HTTP-клиент закрывать не нужно
    },
  };
}

/* ── Прямой Postgres ───────────────────────────────────────────────────── */

export function createPgPowerplayWriter(client: PowerplayPgClient, options: { label?: string } = {}): PowerplayDbWriter {
  const one = async (text: string, values: unknown[]): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await client.query(text, values);
        const row = result.rows?.[0] ?? {};
        return Object.values(row)[0];
      } catch (error) {
        if (!isWriteConflict(error) || attempt >= CONFLICT_RETRIES) throw error;
        await pause(150 * 2 ** attempt);
      }
    }
  };
  return {
    backend: 'pg',
    batchSize: 0,
    label: options.label ?? 'прямой Postgres',
    async apply(rows, runId) {
      const written = count(await one('SELECT public.powerplay_apply_batch($1::uuid, $2::jsonb) AS n', [runId, JSON.stringify(rows)]));
      return { written, calls: 1 };
    },
    async finish(runId, state) {
      return json(await one('SELECT public.powerplay_finish_sync($1::uuid, $2::jsonb) AS result', [runId, JSON.stringify(state)]));
    },
    async close() {
      await client.end().catch(() => undefined);
    },
  };
}

export interface CreatePowerplayWriterOptions {
  svc: Svc;
  log?: LogFn;
  /** Строка подключения; по умолчанию DATABASE_URL / SUPABASE_DB_URL. */
  connectionString?: string | null;
  /** По умолчанию `POWERPLAY_DB_DIRECT`. */
  direct?: boolean;
  /** Готовый клиент (тесты: PGlite). */
  pgClient?: () => Promise<PowerplayPgClient>;
  batchSize?: number;
  /** Попыток подключения к Postgres (тесты — 1). */
  pgAttempts?: number;
}

/**
 * Путь записи для импорта: прямой Postgres, если он задан и отвечает, иначе
 * PostgREST — с объяснением в журнале, почему.
 */
export async function createPowerplayWriter(options: CreatePowerplayWriterOptions): Promise<PowerplayDbWriter> {
  const log = options.log ?? (() => undefined);
  const url = options.connectionString === undefined ? galaxyDbUrl() : options.connectionString;
  const direct = options.direct ?? powerplayDirectDb();
  const postgrest = () => createPostgrestPowerplayWriter(options.svc, { batchSize: options.batchSize, log });

  if (options.pgClient && direct) return createPgPowerplayWriter(await options.pgClient());
  if (!url) {
    log('info', 'Прямой Postgres не задан (DATABASE_URL/SUPABASE_DB_URL) — пишу через PostgREST');
    return postgrest();
  }
  if (!direct) {
    log('info', 'POWERPLAY_DB_DIRECT=0 — прямой Postgres выключен, пишу через PostgREST');
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
    const queryable = client as unknown as PowerplayPgClient;
    return createPgPowerplayWriter({ query: (text, values) => queryable.query(text, values), end: () => client.end() }, { label });
  } catch (error) {
    const detail = isPgConnectionError(error) ? error.failure.message : (error as Error)?.message || String(error);
    log('warn', `Прямой Postgres недоступен — ${detail.slice(0, 300)}. Пишу через PostgREST`);
    return postgrest();
  }
}
