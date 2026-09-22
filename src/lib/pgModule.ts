/**
 * Typed loader for the `pg` driver.
 *
 * `pg` is a runtime dependency (the standalone image keeps it because
 * `/api/galaxy/all-systems` and the in-app Spansh import use it), but this
 * install ships no type declarations for it — `*.d.ts` files are gitignored.
 * The untyped dynamic import is asserted once here so callers get a real
 * interface instead of copying casts around.
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
