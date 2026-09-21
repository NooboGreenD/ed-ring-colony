/**
 * Billing storage adapter.
 *
 * Primary backend — Supabase (service role, bypasses RLS). Falls back to a
 * local JSON file (`data/billing_store.json`) when the service key is missing
 * or the DB is unreachable, so that local previews keep working.
 *
 * Both backends expose the same tiny table API used by the repository.
 */
import fs from 'fs';
import path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, any>;

export interface ListOptions {
  eq?: Record<string, any>;
  neq?: Record<string, any>;
  in?: Record<string, any[]>;
  gte?: Record<string, any>;
  lt?: Record<string, any>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
  offset?: number;
}

export interface TableAdapter {
  readonly kind: 'supabase' | 'file';
  list<T extends Row = Row>(table: string, opts?: ListOptions): Promise<T[]>;
  get<T extends Row = Row>(table: string, id: string): Promise<T | null>;
  insert<T extends Row = Row>(table: string, row: Row): Promise<T>;
  upsert<T extends Row = Row>(table: string, row: Row): Promise<T>;
  update<T extends Row = Row>(table: string, id: string, patch: Row): Promise<T | null>;
  updateWhere(table: string, eq: Record<string, any>, patch: Row): Promise<number>;
  remove(table: string, id: string): Promise<boolean>;
  removeWhere(table: string, eq: Record<string, any>): Promise<number>;
  count(table: string, opts?: ListOptions): Promise<number>;
}

export const TABLE_PK: Record<string, string> = {
  billing_plans: 'id',
  user_subscriptions: 'id',
  shop_items: 'id',
  user_inventory: 'id',
  user_cosmetics_equipped: 'user_id',
  billing_transactions: 'id',
  user_balances: 'user_id',
  payment_providers: 'id',
  payment_intents: 'id',
  payment_webhook_events: 'id',
  billing_settings: 'id',
};

function pkOf(table: string): string {
  return TABLE_PK[table] || 'id';
}

// ───────────────────────────── JSON file backend ─────────────────────────────

const DATA_FILE = path.join(process.cwd(), 'data', 'billing_store.json');

function matches(row: Row, opts?: ListOptions): boolean {
  if (!opts) return true;
  if (opts.eq) for (const [k, v] of Object.entries(opts.eq)) if (row[k] !== v) return false;
  if (opts.neq) for (const [k, v] of Object.entries(opts.neq)) if (row[k] === v) return false;
  if (opts.in) for (const [k, vs] of Object.entries(opts.in)) if (!vs.includes(row[k])) return false;
  if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) if (!(row[k] >= v)) return false;
  if (opts.lt) for (const [k, v] of Object.entries(opts.lt)) if (!(row[k] < v)) return false;
  return true;
}

class FileAdapter implements TableAdapter {
  readonly kind = 'file' as const;
  private data: Record<string, Row[]> = {};

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        // v2 layout: { tables: { name: Row[] } }
        if (parsed && parsed.tables && typeof parsed.tables === 'object') {
          this.data = parsed.tables;
          return;
        }
      }
    } catch (e) {
      console.warn('[billing/storage] Failed to read data file, starting empty:', e);
    }
    this.data = {};
  }

  private save() {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 2, tables: this.data }, null, 2), 'utf-8');
    } catch (e) {
      console.error('[billing/storage] Failed to write data file:', e);
    }
  }

  private table(name: string): Row[] {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  async list<T extends Row>(table: string, opts?: ListOptions): Promise<T[]> {
    let rows = this.table(table).filter((r) => matches(r, opts));
    if (opts?.order) {
      const { column, ascending = true } = opts.order;
      rows = [...rows].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
      });
    }
    const offset = opts?.offset || 0;
    const limit = opts?.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map((r) => ({ ...r })) as T[];
  }

  async get<T extends Row>(table: string, id: string): Promise<T | null> {
    const pk = pkOf(table);
    const row = this.table(table).find((r) => r[pk] === id);
    return row ? ({ ...row } as T) : null;
  }

  async insert<T extends Row>(table: string, row: Row): Promise<T> {
    const pk = pkOf(table);
    if (this.table(table).some((r) => r[pk] === row[pk])) {
      throw new Error(`Duplicate key ${pk}=${row[pk]} in ${table}`);
    }
    this.table(table).push({ ...row });
    this.save();
    return { ...row } as T;
  }

  async upsert<T extends Row>(table: string, row: Row): Promise<T> {
    const pk = pkOf(table);
    const rows = this.table(table);
    const idx = rows.findIndex((r) => r[pk] === row[pk]);
    if (idx === -1) rows.push({ ...row });
    else rows[idx] = { ...rows[idx], ...row };
    this.save();
    return { ...(idx === -1 ? row : rows[idx]) } as T;
  }

  async update<T extends Row>(table: string, id: string, patch: Row): Promise<T | null> {
    const pk = pkOf(table);
    const rows = this.table(table);
    const idx = rows.findIndex((r) => r[pk] === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    this.save();
    return { ...rows[idx] } as T;
  }

  async updateWhere(table: string, eq: Record<string, any>, patch: Row): Promise<number> {
    let n = 0;
    const rows = this.table(table);
    for (let i = 0; i < rows.length; i++) {
      if (matches(rows[i], { eq })) {
        rows[i] = { ...rows[i], ...patch };
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  async remove(table: string, id: string): Promise<boolean> {
    const pk = pkOf(table);
    const rows = this.table(table);
    const before = rows.length;
    this.data[table] = rows.filter((r) => r[pk] !== id);
    const removed = before !== this.data[table].length;
    if (removed) this.save();
    return removed;
  }

  async removeWhere(table: string, eq: Record<string, any>): Promise<number> {
    const rows = this.table(table);
    const before = rows.length;
    this.data[table] = rows.filter((r) => !matches(r, { eq }));
    const n = before - this.data[table].length;
    if (n) this.save();
    return n;
  }

  async count(table: string, opts?: ListOptions): Promise<number> {
    return this.table(table).filter((r) => matches(r, opts)).length;
  }
}

// ───────────────────────────── Supabase backend ─────────────────────────────

class SupabaseAdapter implements TableAdapter {
  readonly kind = 'supabase' as const;
  constructor(private client: SupabaseClient) {}

  private applyFilters(q: any, opts?: ListOptions) {
    if (!opts) return q;
    if (opts.eq) for (const [k, v] of Object.entries(opts.eq)) q = v === null ? q.is(k, null) : q.eq(k, v);
    if (opts.neq) for (const [k, v] of Object.entries(opts.neq)) q = q.neq(k, v);
    if (opts.in) for (const [k, vs] of Object.entries(opts.in)) q = q.in(k, vs);
    if (opts.gte) for (const [k, v] of Object.entries(opts.gte)) q = q.gte(k, v);
    if (opts.lt) for (const [k, v] of Object.entries(opts.lt)) q = q.lt(k, v);
    return q;
  }

  private fail(op: string, table: string, error: any): never {
    const msg = error?.message || String(error);
    const err = new Error(`[billing/supabase] ${op} ${table}: ${msg}`);
    (err as any).code = error?.code;
    throw err;
  }

  async list<T extends Row>(table: string, opts?: ListOptions): Promise<T[]> {
    let q = this.applyFilters(this.client.from(table).select('*'), opts);
    if (opts?.order) q = q.order(opts.order.column, { ascending: opts.order.ascending ?? true, nullsFirst: false });
    if (opts?.limit !== undefined || opts?.offset !== undefined) {
      const from = opts.offset || 0;
      const to = from + (opts.limit ?? 1000) - 1;
      q = q.range(from, to);
    }
    const { data, error } = await q;
    if (error) this.fail('list', table, error);
    return (data || []) as T[];
  }

  async get<T extends Row>(table: string, id: string): Promise<T | null> {
    const { data, error } = await this.client.from(table).select('*').eq(pkOf(table), id).maybeSingle();
    if (error) this.fail('get', table, error);
    return (data as T) || null;
  }

  async insert<T extends Row>(table: string, row: Row): Promise<T> {
    const { data, error } = await this.client.from(table).insert(row).select('*').single();
    if (error) this.fail('insert', table, error);
    return data as T;
  }

  async upsert<T extends Row>(table: string, row: Row): Promise<T> {
    const { data, error } = await this.client.from(table).upsert(row, { onConflict: pkOf(table) }).select('*').single();
    if (error) this.fail('upsert', table, error);
    return data as T;
  }

  async update<T extends Row>(table: string, id: string, patch: Row): Promise<T | null> {
    const { data, error } = await this.client.from(table).update(patch).eq(pkOf(table), id).select('*').maybeSingle();
    if (error) this.fail('update', table, error);
    return (data as T) || null;
  }

  async updateWhere(table: string, eq: Record<string, any>, patch: Row): Promise<number> {
    const q = this.applyFilters(this.client.from(table).update(patch), { eq }).select('id');
    const { data, error } = await q;
    if (error) this.fail('updateWhere', table, error);
    return data?.length || 0;
  }

  async remove(table: string, id: string): Promise<boolean> {
    const { data, error } = await this.client.from(table).delete().eq(pkOf(table), id).select(pkOf(table));
    if (error) this.fail('remove', table, error);
    return (data?.length || 0) > 0;
  }

  async removeWhere(table: string, eq: Record<string, any>): Promise<number> {
    const q = this.applyFilters(this.client.from(table).delete(), { eq }).select(pkOf(table));
    const { data, error } = await q;
    if (error) this.fail('removeWhere', table, error);
    return data?.length || 0;
  }

  async count(table: string, opts?: ListOptions): Promise<number> {
    const q = this.applyFilters(this.client.from(table).select('*', { count: 'exact', head: true }), opts);
    const { count, error } = await q;
    if (error) this.fail('count', table, error);
    return count || 0;
  }
}

// ───────────────────────────── Factory ─────────────────────────────

const g = globalThis as unknown as { __billingAdapter?: TableAdapter; __billingAdapterPromise?: Promise<TableAdapter> };

export function hasSupabaseServiceConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function buildAdapter(): Promise<TableAdapter> {
  if (hasSupabaseServiceConfig() && process.env.BILLING_STORAGE !== 'file') {
    try {
      const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, { ...init, cache: 'no-store' }) },
      });
      // Probe: the billing tables must exist (migration applied).
      const { error } = await client.from('shop_items').select('id', { count: 'exact', head: true });
      if (error) throw error;
      console.info('[billing/storage] Using Supabase backend');
      return new SupabaseAdapter(client);
    } catch (e: any) {
      console.warn('[billing/storage] Supabase unavailable, falling back to file store:', e?.message || e);
    }
  }
  console.info('[billing/storage] Using local JSON file backend');
  return new FileAdapter();
}

export function getBillingAdapter(): Promise<TableAdapter> {
  if (g.__billingAdapter) return Promise.resolve(g.__billingAdapter);
  if (!g.__billingAdapterPromise) {
    g.__billingAdapterPromise = buildAdapter().then((a) => {
      g.__billingAdapter = a;
      return a;
    });
  }
  return g.__billingAdapterPromise;
}

/** Reset cached adapter (tests / after config changes). */
export function resetBillingAdapter() {
  g.__billingAdapter = undefined;
  g.__billingAdapterPromise = undefined;
}
