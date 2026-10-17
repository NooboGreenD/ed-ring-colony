/**
 * Клиент «как supabase-js», который исполняет запросы в PGlite.
 *
 * Маршруты, работающие service-role клиентом, так проверяются на настоящем
 * PostgreSQL с настоящими миграциями: ограничения, триггеры и SQL-функции
 * срабатывают по-честному, а не по договорённости заглушки.
 *
 * Поддерживается то подмножество построителя запросов PostgREST, которым
 * пользуются маршруты: select/insert/update/upsert/delete, фильтры eq, neq,
 * in, is, ilike, gt/gte/lt/lte, order, limit, range, single/maybeSingle и
 * rpc (в том числе с order/range для функций, возвращающих набор строк).
 * Встраивание связанных таблиц (`profiles(name)`) и `or()` не поддерживаются.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Типы как у PostgREST: bigint и numeric — числа, время — ISO-строки, date — строка. */
const PARSERS = {
  20: (value) => Number(value),
  1700: (value) => Number(value),
  1082: (value) => value,
  1114: (value) => new Date(`${value.replace(' ', 'T')}Z`).toISOString(),
  1184: (value) => new Date(value).toISOString(),
};

function ident(name) {
  const value = String(name).trim();
  if (!IDENT.test(value)) throw new Error(`pgliteSupabase: недопустимый идентификатор «${name}»`);
  return `"${value}"`;
}

function columnsList(columns) {
  const raw = String(columns ?? '*').trim();
  if (raw === '*' || raw === '') return '*';
  return raw.split(',').map((part) => ident(part.trim())).join(', ');
}

function encode(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function pgError(error) {
  return { message: error?.message ?? String(error), code: error?.code ?? null, details: error?.detail ?? null };
}

class Builder {
  constructor(state, table, rpc = null) {
    this.state = state;
    this.table = table;
    this.rpcCall = rpc;
    this.verb = rpc ? 'rpc' : 'select';
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.singleMode = null;
    this.payload = null;
    this.returning = false;
    this.upsertOptions = {};
  }

  select(columns = '*') {
    if (this.verb === 'select' || this.verb === 'rpc') this.columns = columns;
    else {
      this.returning = true;
      this.columns = columns;
    }
    return this;
  }

  insert(rows) { this.verb = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, options = {}) { this.verb = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = options; return this; }
  update(patch) { this.verb = 'update'; this.payload = patch; return this; }
  delete() { this.verb = 'delete'; return this; }

  eq(column, value) { this.filters.push(['eq', column, value]); return this; }
  neq(column, value) { this.filters.push(['neq', column, value]); return this; }
  gt(column, value) { this.filters.push(['>', column, value]); return this; }
  gte(column, value) { this.filters.push(['>=', column, value]); return this; }
  lt(column, value) { this.filters.push(['<', column, value]); return this; }
  lte(column, value) { this.filters.push(['<=', column, value]); return this; }
  in(column, values) { this.filters.push(['in', column, values]); return this; }
  is(column, value) { this.filters.push(['is', column, value]); return this; }
  ilike(column, value) { this.filters.push(['ilike', column, value]); return this; }
  order(column, options = {}) { this.orders.push([column, options.ascending !== false, options.nullsFirst]); return this; }
  limit(value) { this.limitValue = value; return this; }
  range(from, to) { this.offsetValue = from; this.limitValue = to - from + 1; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this.execute(); }
  single() { this.singleMode = 'one'; return this.execute(); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  where(params) {
    const parts = [];
    for (const [op, column, value] of this.filters) {
      const col = ident(column);
      if (op === 'eq') {
        if (value === null) parts.push(`${col} IS NULL`);
        else { params.push(value); parts.push(`${col} = $${params.length}`); }
      } else if (op === 'neq') {
        params.push(value); parts.push(`${col} <> $${params.length}`);
      } else if (op === 'in') {
        const list = Array.isArray(value) ? value : [];
        if (!list.length) parts.push('false');
        else { params.push(list); parts.push(`${col} = ANY($${params.length})`); }
      } else if (op === 'is') {
        parts.push(value === null ? `${col} IS NULL` : value === true ? `${col} IS TRUE` : `${col} IS FALSE`);
      } else if (op === 'ilike') {
        params.push(value); parts.push(`${col}::text ILIKE $${params.length}`);
      } else {
        params.push(value); parts.push(`${col} ${op} $${params.length}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  tail() {
    let sql = '';
    if (this.orders.length) {
      sql += ` ORDER BY ${this.orders.map(([column, ascending, nullsFirst]) => {
        const nulls = nullsFirst === undefined ? '' : nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
        return `${ident(column)} ${ascending ? 'ASC' : 'DESC'}${nulls}`;
      }).join(', ')}`;
    }
    if (Number.isInteger(this.limitValue)) sql += ` LIMIT ${this.limitValue}`;
    if (Number.isInteger(this.offsetValue)) sql += ` OFFSET ${this.offsetValue}`;
    return sql;
  }

  async run(sql, params) {
    this.state.log?.push(sql);
    return this.state.db.query(sql, params, { parsers: PARSERS });
  }

  async execute() {
    try {
      let rows;
      if (this.verb === 'rpc') {
        rows = await this.executeRpc();
        if (!Array.isArray(rows)) return { data: rows, error: null };
      } else {
        rows = await this.executeTable();
      }
      if (this.singleMode) {
        if (rows.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        if (!rows.length) {
          return this.singleMode === 'one'
            ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
            : { data: null, error: null };
        }
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: pgError(error) };
    }
  }

  async executeTable() {
    const table = ident(this.table);
    const params = [];
    if (this.verb === 'select') {
      const sql = `SELECT ${columnsList(this.columns)} FROM ${table}${this.where(params)}${this.tail()}`;
      return (await this.run(sql, params)).rows;
    }
    const returning = this.returning ? ` RETURNING ${columnsList(this.columns)}` : '';
    if (this.verb === 'insert' || this.verb === 'upsert') {
      const rows = this.payload ?? [];
      if (!rows.length) return [];
      const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
      const values = rows.map((row) => `(${keys.map((key) => {
        if (!(key in row) || row[key] === undefined) return 'DEFAULT';
        params.push(encode(row[key]));
        return `$${params.length}`;
      }).join(', ')})`);
      let sql = `INSERT INTO ${table} (${keys.map(ident).join(', ')}) VALUES ${values.join(', ')}`;
      if (this.verb === 'upsert') {
        const conflict = this.upsertOptions.onConflict
          ? String(this.upsertOptions.onConflict).split(',').map((part) => ident(part.trim()))
          : await this.primaryKey();
        sql += this.upsertOptions.ignoreDuplicates
          ? ` ON CONFLICT (${conflict.join(', ')}) DO NOTHING`
          : ` ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${keys.map((key) => `${ident(key)} = EXCLUDED.${ident(key)}`).join(', ')}`;
      }
      const result = await this.run(sql + returning, params);
      return result.rows ?? [];
    }
    if (this.verb === 'update') {
      const entries = Object.entries(this.payload ?? {}).filter(([, value]) => value !== undefined);
      const sets = entries.map(([key, value]) => {
        params.push(encode(value));
        return `${ident(key)} = $${params.length}`;
      });
      const sql = `UPDATE ${table} SET ${sets.join(', ')}${this.where(params)}${returning}`;
      return (await this.run(sql, params)).rows ?? [];
    }
    if (this.verb === 'delete') {
      const sql = `DELETE FROM ${table}${this.where(params)}${returning}`;
      return (await this.run(sql, params)).rows ?? [];
    }
    throw new Error(`pgliteSupabase: неизвестная операция ${this.verb}`);
  }

  async primaryKey() {
    const { rows } = await this.state.db.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`, [`public.${this.table}`]);
    return rows.map((row) => ident(row.attname));
  }

  async executeRpc() {
    const { name, args } = this.rpcCall;
    const fn = ident(name);
    const { rows: meta } = await this.state.db.query(
      `SELECT p.proretset, t.typname FROM pg_proc p JOIN pg_type t ON t.oid = p.prorettype
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`, [name]);
    if (!meta.length) throw Object.assign(new Error(`Could not find the function public.${name}`), { code: 'PGRST202' });
    const params = [];
    const named = Object.entries(args ?? {}).map(([key, value]) => {
      params.push(encode(value));
      return `${ident(key)} => $${params.length}`;
    });
    if (this.state.rpcGuard) await this.state.rpcGuard(name, args);
    if (meta[0].proretset) {
      const sql = `SELECT ${columnsList(this.columns)} FROM ${fn}(${named.join(', ')})${this.where(params)}${this.tail()}`;
      return (await this.run(sql, params)).rows;
    }
    const sql = `SELECT ${fn}(${named.join(', ')}) AS value`;
    const { rows } = await this.run(sql, params);
    return meta[0].typname === 'void' ? null : rows[0]?.value ?? null;
  }
}

/**
 * @param {{ db: import('@electric-sql/pglite').PGlite, userId?: string|null, log?: string[] }} state
 */
export function pgliteClient(state) {
  return {
    from: (table) => new Builder(state, table),
    rpc: (name, args) => new Builder(state, null, { name, args }),
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null }, error: null }),
    },
  };
}
