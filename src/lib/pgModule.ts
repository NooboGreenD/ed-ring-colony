/**
 * Typed loader for the `pg` driver + one shared way to open a connection.
 *
 * `pg` is a runtime dependency (the standalone image keeps it because
 * `/api/galaxy/all-systems` and the in-app Spansh import use it), but this
 * install ships no type declarations for it — `*.d.ts` files are gitignored.
 * The untyped dynamic import is asserted once here so callers get a real
 * interface instead of copying casts around.
 *
 * `connectPgClient` wraps every direct-Postgres connection in the project with
 * the same two behaviours, because a bare `getaddrinfo EAI_AGAIN db` in the
 * admin panel told nobody what to fix:
 *
 * 1. transient failures (Docker's embedded DNS answers `EAI_AGAIN` while it
 *    warms up, a restarting Postgres answers `ECONNREFUSED`) are retried a few
 *    times with a backoff instead of failing the import on the first second;
 * 2. a permanent failure is reported as an actionable sentence naming the host
 *    from `DATABASE_URL` and the concrete ways to reach it, so a container that
 *    cannot see the `db` service of another Compose network is a config fix,
 *    not a mystery.
 */

export interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export interface PgQueryEvents {
  on(event: 'row', listener: (row: Record<string, unknown>) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
}

export interface PgClientLike {
  connect(): Promise<void>;
  query(query: string | PgQueryEvents): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike & { release(): void }>;
  query(query: string): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export interface PgClientConfig {
  connectionString: string;
  statement_timeout?: number;
  query_timeout?: number;
  /** Fail fast instead of waiting for the OS TCP timeout when the DB is down. */
  connectionTimeoutMillis?: number;
}

export interface PgModule {
  Client: new (config: PgClientConfig) => PgClientLike;
  Pool: new (config: { connectionString: string; max?: number; statement_timeout?: number; connectionTimeoutMillis?: number }) => PgPoolLike;
  Query: new (text: string) => PgQueryEvents;
}

interface PgNamespace extends Partial<PgModule> {
  default?: PgModule;
}

/** Direct Postgres URL for server-side bulk work (import, point-cloud build). */
export function galaxyDbUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DATABASE_URL?.trim() || env.SUPABASE_DB_URL?.trim() || null;
}

export async function loadPg(): Promise<PgModule> {
  // @ts-expect-error pg ships without type declarations in this install.
  const loaded = (await import('pg')) as PgNamespace;
  const pg = loaded.Client && loaded.Query && loaded.Pool ? loaded : loaded.default;
  if (!pg?.Client || !pg.Query || !pg.Pool) throw new Error('pg module is incomplete (Client/Pool/Query missing)');
  return pg as PgModule;
}

// ─────────────────── connection failures and retries ───────────────────

/** What kind of problem stopped the connection: it decides retry and wording. */
export type PgConnectionFailureKind = 'dns' | 'refused' | 'timeout' | 'auth' | 'ssl' | 'unknown';

export interface PgConnectionFailure {
  kind: PgConnectionFailureKind;
  /** Node/libpq code when present (`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`…). */
  code: string | null;
  /** Host from the connection string (what the message has to name). */
  host: string | null;
  port: string | null;
  /** DNS and refused sockets can recover by themselves; a wrong password cannot. */
  retryable: boolean;
  /** Raw driver text, e.g. `getaddrinfo EAI_AGAIN db` — safe to log. */
  detail: string;
  /** The full sentence shown to the operator: what failed and what to change. */
  message: string;
}

/** Errors whose name resolution may succeed on the next attempt. */
const DNS_FAILURE_CODES = ['EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA', 'ENODATA', 'ENOTFOUND'];
/** Pauses between connection attempts; the last value repeats. */
export const PG_CONNECT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000];

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Host/port a connection string points at (`null` for keyword/value strings). */
export function pgConnectionTarget(connectionString: string): { host: string; port: string | null } | null {
  try {
    const url = new URL(connectionString);
    if (!url.hostname) return null;
    // `URL#hostname` keeps IPv6 literals bracketed.
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || null };
  } catch {
    return null;
  }
}

function failureText(error: unknown): { detail: string; code: string | null } {
  const candidate = error as
    | { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } }
    | null
    | undefined;
  const own = typeof candidate?.message === 'string' && candidate.message ? candidate.message : '';
  const cause = typeof candidate?.cause?.message === 'string' ? candidate.cause.message : '';
  const detail = own || cause || String(error ?? 'unknown error');
  const code =
    (typeof candidate?.code === 'string' && candidate.code) ||
    (typeof candidate?.cause?.code === 'string' && candidate.cause.code) ||
    null;
  return { detail, code };
}

/** Where a config-level fix is the only way forward (no amount of retrying helps). */
const AUTH_FAILURE_TEXT =
  /password authentication failed|no pg_hba\.conf entry|role "?\w+"? does not exist|database "?[\w-]+"? does not exist|no password supplied/i;
const SSL_FAILURE_TEXT = /SSL|TLS|certificate|self.signed/i;
const TIMEOUT_FAILURE_TEXT = /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|EAI_RETRY|connection timeout|timeout expired|terminating connection/i;

function dnsHint(host: string | null): string {
  const where = host
    ? `Хост «${host}» из DATABASE_URL/SUPABASE_DB_URL не резолвится`
    : 'Хост из DATABASE_URL/SUPABASE_DB_URL не резолвится';
  return (
    `${where}. Такое имя существует только внутри docker-сети того стека, где объявлен сервис ` +
    '(self-hosted Supabase: сервис db, контейнер supabase-db, сеть supabase_default). ' +
    'Либо подключите процесс к этой сети (в docker-compose — external network supabase_default), ' +
    'либо укажите адрес, видимый отсюда: host.docker.internal, 172.17.0.1 или IP сервера с опубликованным портом Postgres; ' +
    'либо уберите DATABASE_URL/SUPABASE_DB_URL — тогда импорт пойдёт через PostgREST (медленнее, но без прямого подключения).'
  );
}

/**
 * Turn a driver error into a classification the callers can act on: the import
 * retries `retryable` failures and shows `message` for the rest.
 */
export function describePgConnectionError(error: unknown, connectionString: string): PgConnectionFailure {
  const { detail, code } = failureText(error);
  const target = pgConnectionTarget(connectionString);
  // «на db:5432» / «к db:5432» — or nothing when the string is not a URL.
  const at = target ? `${target.host}${target.port ? `:${target.port}` : ''}` : null;
  const haystack = `${code ?? ''} ${detail}`;

  const base = { code, host: target?.host ?? null, port: target?.port ?? null, detail };

  if (DNS_FAILURE_CODES.some((value) => haystack.includes(value)) || /getaddrinfo/i.test(haystack)) {
    return { ...base, kind: 'dns', retryable: true, message: `Postgres недоступен: ${detail}. ${dnsHint(target?.host ?? null)}` };
  }
  if (haystack.includes('ECONNREFUSED') || /connection refused|server closed the connection unexpectedly/i.test(haystack)) {
    return {
      ...base,
      kind: 'refused',
      retryable: true,
      message:
        `Postgres не отвечает${at ? ` на ${at}` : ''}: ${detail}. ` +
        'Сервис не запущен, порт не опубликован наружу или подключение идёт не в ту docker-сеть — ' +
        'проверьте состояние контейнера БД (docker ps, docker logs supabase-db) и адрес в DATABASE_URL.',
    };
  }
  if (AUTH_FAILURE_TEXT.test(haystack)) {
    return {
      ...base,
      kind: 'auth',
      retryable: false,
      message: `Postgres отклонил подключение${at ? ` к ${at}` : ''}: ${detail}. Проверьте пользователя, пароль и правила pg_hba в DATABASE_URL.`,
    };
  }
  if (SSL_FAILURE_TEXT.test(haystack)) {
    return {
      ...base,
      kind: 'ssl',
      retryable: false,
      message: `Postgres не принял TLS-соединение${at ? ` с ${at}` : ''}: ${detail}. Добавьте sslmode=require (или отключите SSL в строке подключения).`,
    };
  }
  if (TIMEOUT_FAILURE_TEXT.test(haystack)) {
    return {
      ...base,
      kind: 'timeout',
      retryable: true,
      message:
        `Не удалось достучаться до Postgres${at ? ` на ${at}` : ''}: ${detail}. ` +
        'Похоже на firewall/маршрут: проверьте, что порт открыт для этого контейнера и что адрес в DATABASE_URL правильный.',
    };
  }
  return {
    ...base,
    kind: 'unknown',
    retryable: false,
    message: `Postgres недоступен${at ? ` (${at})` : ''}: ${detail}`,
  };
}

/**
 * The error `connectWithRetries` throws once it gives up. Callers that can fall
 * back to another backend (the catalog import → PostgREST) check for it with
 * {@link isPgConnectionError} and reuse the ready-made `message`.
 */
export class PgConnectionError extends Error {
  readonly failure: PgConnectionFailure;

  constructor(failure: PgConnectionFailure) {
    super(failure.message);
    this.name = 'PgConnectionError';
    this.failure = failure;
  }
}

/** `instanceof` is unreliable across bundled module copies, so also duck-type. */
export function isPgConnectionError(error: unknown): error is PgConnectionError {
  if (error instanceof PgConnectionError) return true;
  const failure = (error as { name?: string; failure?: PgConnectionFailure } | null)?.failure;
  return (
    (error as Error | null)?.name === 'PgConnectionError' &&
    Boolean(failure && typeof failure.kind === 'string' && typeof failure.message === 'string')
  );
}

export interface PgConnectRetryOptions<T> {
  connectionString: string;
  /** One attempt. Must reject on failure and leave no half-open resource. */
  connect: () => Promise<T>;
  /** Total attempts (default: one per backoff step plus one = 4). */
  attempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Retry a connection attempt while the failure looks transient.
 *
 * `getaddrinfo EAI_AGAIN` is by definition a temporary resolution failure —
 * Docker's embedded DNS returns it both for an unknown service name and for a
 * valid one it could not answer in time — so the first seconds after a restart
 * must not decide the fate of a multi-hour import.
 */
export async function connectWithRetries<T>(options: PgConnectRetryOptions<T>): Promise<T> {
  const backoffMs = options.backoffMs ?? PG_CONNECT_BACKOFF_MS;
  const attempts = Math.max(1, options.attempts ?? backoffMs.length + 1);
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => undefined);

  let failure: PgConnectionFailure | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await options.connect();
    } catch (error) {
      failure = describePgConnectionError(error, options.connectionString);
      if (!failure.retryable || attempt >= attempts) break;
      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      log(
        `Postgres: попытка ${attempt}/${attempts} не удалась (${failure.detail}), повтор через ${Math.round(delay / 1000)} с`,
      );
      await sleep(delay);
    }
  }
  throw new PgConnectionError(failure ?? describePgConnectionError(new Error('connection failed'), options.connectionString));
}

export interface ConnectPgClientOptions {
  connectionString: string;
  pg?: PgModule;
  /** Server-side statement limit; 0 (the default) disables it for bulk work. */
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  /** Fail fast instead of waiting for the OS TCP timeout when the host is dead. */
  connectionTimeoutMillis?: number;
  attempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Open a `pg` client, retrying transient DNS/refused failures. */
export async function connectPgClient(options: ConnectPgClientOptions): Promise<PgClientLike> {
  const pg = options.pg ?? (await loadPg());
  return connectWithRetries<PgClientLike>({
    connectionString: options.connectionString,
    attempts: options.attempts,
    backoffMs: options.backoffMs,
    sleep: options.sleep,
    log: options.log,
    connect: async () => {
      const client: PgClientLike = new pg.Client({
        connectionString: options.connectionString,
        statement_timeout: options.statementTimeoutMs ?? 0,
        query_timeout: options.queryTimeoutMs ?? 0,
        connectionTimeoutMillis: options.connectionTimeoutMillis ?? 15_000,
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        // A failed handshake still owns a socket: close it before retrying.
        await client.end().catch(() => undefined);
        throw error;
      }
    },
  });
}
