/**
 * Массовая запись каталога систем через `COPY FROM STDIN` (быстрый путь).
 *
 * Почему это понадобилось. Исходный писатель (`createPgWriter`) шлёт
 * `INSERT … VALUES (…) ON CONFLICT (name_lc) DO UPDATE` пачками по 2000 строк,
 * а перед ним — `DELETE … WHERE name_lc IN (…) OR id64 IN (…)`. На каталоге в
 * 2×10⁸ строк это упирается в три вещи сразу:
 *
 * 1. `OR` по двум разным уникальным индексам планировщик не умеет закрыть
 *    bitmap-OR по спискам из 2000 литералов — на большой таблице это легко
 *    превращается в seq scan, то есть десятки секунд на пачку. Отсюда и
 *    наблюдаемые «20 систем/с»;
 * 2. текстовый `INSERT` на 2000×13 литералов — это мегабайты SQL, которые
 *    сервер заново парсит и планирует на каждую пачку;
 * 3. каждая строка сразу попадает во все индексы таблицы, включая GIN
 *    (`name_lc gin_trgm_ops`) и GiST (`cube(ARRAY[x,y,z])`) — самые дорогие
 *    на вставку.
 *
 * Что делает этот модуль:
 *
 * - строки уходят в **UNLOGGED staging-таблицу** одним `COPY FROM STDIN`
 *   (бинарный по объёму трафик, без парсинга SQL, без WAL для staging);
 * - раз в `mergeRows` строк staging схлопывается по обоим уникальным ключам и
 *   одной транзакцией вливается в `galaxy_systems`: `DELETE … USING stage`
 *   (hash join по индексу, без `OR` и без списков литералов) + один
 *   `INSERT … SELECT … ON CONFLICT (name_lc) DO UPDATE`;
 * - интерфейс остался `GalaxyRowWriter`, поэтому и CLI, и админка, и импорт из
 *   шардов подхватывают путь без изменений в вызывающем коде.
 *
 * Пункт 3 (индексы) этот модуль решить не может: см.
 * `supabase/maintenance/galaxy_systems_bulk_load.sql` — снять тяжёлые индексы
 * на время холодной заливки и построить их `CONCURRENTLY` после.
 */

import {
  GALAXY_META_TABLE,
  GALAXY_ROW_COLUMNS,
  GALAXY_TABLE,
  galaxyRowSupersedes,
  type GalaxyImportBackend,
  type GalaxyRowWriter,
} from './galaxyImport.ts';
import type { GalaxySystemPoint } from './galaxySystems.ts';
import type { GalaxySystemRecord } from './galaxySpanshStream.ts';
import { connectPgClient, loadPg, type PgClientLike, type PgModule } from './pgModule.ts';

void GALAXY_META_TABLE;

/** UNLOGGED-приёмник `COPY`. Живёт между запусками: его `TRUNCATE` стоит O(1). */
export const GALAXY_STAGE_TABLE = 'galaxy_systems_stage';

/** Строк в одном `COPY`-потоке до паузы на запись в сеть. */
export const COPY_CHUNK_ROWS = 50_000;

/**
 * Строк в staging до слияния с каталогом.
 *
 * Крупнее — меньше проходов по `galaxy_systems`, но дольше транзакция и больше
 * «потеря» при падении (переделывается один merge). 250 тыс. строк — это
 * ~800 merge-ов на весь дамп и секунды на транзакцию.
 */
export const COPY_MERGE_ROWS = 250_000;

type PgCopyClient = PgClientLike & {
  query(query: unknown): Promise<unknown>;
};

interface CopyFromStream extends NodeJS.WritableStream {
  on(event: 'finish' | 'error' | 'end', listener: (...args: unknown[]) => void): this;
}

type CopyFromFactory = (sql: string) => unknown;

/**
 * `pg-copy-streams` подключается лениво: без него путь просто недоступен, а не
 * ломает сборку (образ без dev-зависимостей, старый деплой и т.п.).
 */
export async function loadCopyFrom(): Promise<CopyFromFactory | null> {
  try {
    const loaded = (await import('pg-copy-streams')) as {
      from?: CopyFromFactory;
      default?: { from?: CopyFromFactory };
    };
    return loaded.from ?? loaded.default?.from ?? null;
  } catch {
    return null;
  }
}

/** Экранирование значения для текстового формата `COPY` (не для SQL!). */
export function copyValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Одна строка каталога в текстовом формате `COPY` (с переводом строки). */
export function copyLine(row: GalaxySystemRecord): string {
  let line = '';
  for (let i = 0; i < GALAXY_ROW_COLUMNS.length; i++) {
    if (i > 0) line += '\t';
    line += copyValue(row[GALAXY_ROW_COLUMNS[i]]);
  }
  return `${line}\n`;
}

const COLUMN_LIST = GALAXY_ROW_COLUMNS.join(',');

/** DDL приёмника: та же форма строки, никаких индексов и никакого WAL. */
export function stageDdlSql(): string {
  return (
    `CREATE UNLOGGED TABLE IF NOT EXISTS ${GALAXY_STAGE_TABLE} ` +
    `(LIKE ${GALAXY_TABLE} INCLUDING DEFAULTS EXCLUDING INDEXES EXCLUDING CONSTRAINTS EXCLUDING IDENTITY)`
  );
}

export function copySql(): string {
  return `COPY ${GALAXY_STAGE_TABLE} (${COLUMN_LIST}) FROM STDIN`;
}

/**
 * Слияние staging → каталог. Порядок важен и держится в одной транзакции:
 *
 * 1–2. Схлопнуть дубли внутри пачки по `name_lc` и по `id64` — иначе
 *      `ON CONFLICT DO UPDATE` упадёт на 21000 («cannot affect row a second
 *      time»), а второй уникальный индекс — на 23505. Это hash-self-join по
 *      UNLOGGED-таблице без индексов: дёшево.
 * 3.   Убрать из каталога строки, которые займут `id64` под другим именем
 *      (система переименована). Это `DELETE … USING` по уникальному индексу
 *      `uq_galaxy_systems_id64` — без списков литералов и без `OR`.
 * 4.   Один `INSERT … SELECT … ON CONFLICT (name_lc) DO UPDATE`.
 */
export function mergeStatements(): string[] {
  const updates = GALAXY_ROW_COLUMNS.filter((column) => column !== 'name_lc')
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', ');
  return [
    `DELETE FROM ${GALAXY_STAGE_TABLE} a USING ${GALAXY_STAGE_TABLE} b ` +
      `WHERE a.ctid < b.ctid AND a.name_lc = b.name_lc`,
    `DELETE FROM ${GALAXY_STAGE_TABLE} a USING ${GALAXY_STAGE_TABLE} b ` +
      `WHERE a.ctid < b.ctid AND a.id64 = b.id64`,
    `DELETE FROM ${GALAXY_TABLE} g USING ${GALAXY_STAGE_TABLE} s ` +
      `WHERE g.id64 = s.id64 AND g.name_lc <> s.name_lc`,
    `INSERT INTO ${GALAXY_TABLE} (${COLUMN_LIST}) SELECT ${COLUMN_LIST} FROM ${GALAXY_STAGE_TABLE} ` +
      `ON CONFLICT (name_lc) DO UPDATE SET ${updates}`,
  ];
}

function starTypeOf(value: unknown): GalaxySystemPoint['starType'] {
  return typeof value === 'string' && value ? (value as GalaxySystemPoint['starType']) : 'unknown';
}

export interface PgCopyWriterOptions {
  pg?: PgModule;
  /** Инъекция для тестов; по умолчанию — `pg-copy-streams`. */
  copyFrom?: CopyFromFactory;
  truncate?: boolean;
  /** Строк в staging до слияния (`GALAXY_COPY_MERGE_ROWS`). */
  mergeRows?: number;
  attempts?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Писатель каталога на `COPY`. Возвращает тот же `GalaxyRowWriter`, что и
 * `createPgWriter`, поэтому подменяется один в один.
 *
 * `deferred` всегда 0: откладывать нечего — пачка здесь не «тайм-аутит
 * построчно», она либо вливается целиком, либо падает с настоящей ошибкой.
 */
export async function createPgCopyWriter(
  connectionString: string,
  options: PgCopyWriterOptions = {},
): Promise<GalaxyRowWriter> {
  const pg = options.pg ?? (await loadPg());
  const copyFrom = options.copyFrom ?? (await loadCopyFrom());
  if (!copyFrom) throw new Error('pg-copy-streams не установлен — быстрый COPY-путь недоступен');
  const mergeRows = Math.max(1000, options.mergeRows ?? COPY_MERGE_ROWS);

  const client = (await connectPgClient({
    connectionString,
    pg,
    statementTimeoutMs: 0,
    queryTimeoutMs: 0,
    connectionTimeoutMillis: 15_000,
    attempts: options.attempts,
    sleep: options.sleep,
    log: options.log,
  })) as PgCopyClient;

  const sql = (text: string): Promise<{ rowCount?: number | null }> =>
    client.query(text) as Promise<{ rowCount?: number | null }>;

  // Массовая заливка не обязана fsync-ать WAL на каждый commit: импорт
  // идемпотентен и возобновляем, а synchronous_commit стоит ~2× времени.
  await sql('SET synchronous_commit = OFF').catch(() => undefined);
  await sql(stageDdlSql());
  await sql(`TRUNCATE ${GALAXY_STAGE_TABLE}`);
  if (options.truncate) await sql(`TRUNCATE ${GALAXY_TABLE} RESTART IDENTITY`);

  let buffer: GalaxySystemRecord[] = [];
  let staged = 0;
  let written = 0;

  const copyBuffer = async (rows: GalaxySystemRecord[]): Promise<void> => {
    if (rows.length === 0) return;
    const stream = client.query(copyFrom(copySql())) as unknown as CopyFromStream;
    await new Promise<void>((resolve, reject) => {
      stream.on('error', (error) => reject(error as Error));
      stream.on('finish', () => resolve());
      let text = '';
      for (let i = 0; i < rows.length; i++) {
        text += copyLine(rows[i]);
        // Строки склеиваются пачками: один write на 50 тыс. строк дешевле
        // 50 тыс. вызовов, но держать в памяти весь шард незачем.
        if (i % COPY_CHUNK_ROWS === COPY_CHUNK_ROWS - 1) {
          stream.write(text);
          text = '';
        }
      }
      if (text) stream.write(text);
      stream.end();
    });
    staged += rows.length;
  };

  /** Слить staging в каталог одной транзакцией и очистить приёмник. */
  const merge = async (): Promise<number> => {
    if (staged === 0) return 0;
    await sql('BEGIN');
    try {
      let inserted = 0;
      for (const statement of mergeStatements()) {
        const result = await sql(statement);
        inserted = Number(result?.rowCount ?? 0);
      }
      await sql(`TRUNCATE ${GALAXY_STAGE_TABLE}`);
      await sql('COMMIT');
      staged = 0;
      written += inserted;
      return inserted;
    } catch (error) {
      await sql('ROLLBACK').catch(() => undefined);
      // Приёмник остаётся с данными упавшей пачки: следующая попытка должна
      // начинать с чистого листа, иначе строки задвоятся.
      await sql(`TRUNCATE ${GALAXY_STAGE_TABLE}`).catch(() => undefined);
      staged = 0;
      throw error;
    }
  };

  const streamQuery = (text: string, onRow: (row: Record<string, unknown>) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const query = new pg.Query(text);
      query.on('row', onRow);
      query.on('error', reject);
      query.on('end', () => resolve());
      void client.query(query);
    });

  const flush = async (): Promise<number> => {
    const rows = buffer;
    buffer = [];
    await copyBuffer(rows);
    return merge();
  };

  return {
    backend: 'pg' as GalaxyImportBackend,
    get written() {
      return written;
    },
    get deferred() {
      return 0;
    },
    async add(row) {
      buffer.push(row);
      if (buffer.length >= COPY_CHUNK_ROWS) {
        const rows = buffer;
        buffer = [];
        await copyBuffer(rows);
        if (staged >= mergeRows) await merge();
      }
    },
    flush,
    async retryDeferred() {
      // Нечего повторять: см. комментарий про `deferred` выше.
    },
    async countRows() {
      const result = (await sql(`SELECT COUNT(*)::bigint AS n FROM ${GALAXY_TABLE}`)) as {
        rows?: Array<Record<string, unknown>>;
      };
      return Number(result.rows?.[0]?.n ?? 0);
    },
    async readPoints(onPoint) {
      let count = 0;
      await streamQuery(`SELECT id64, x, y, z, star_type FROM ${GALAXY_TABLE} ORDER BY id`, (row) => {
        count++;
        onPoint({
          x: Number(row.x),
          y: Number(row.y),
          z: Number(row.z),
          id64: String(row.id64 ?? ''),
          starType: starTypeOf(row.star_type),
        });
      });
      return count;
    },
    async analyze() {
      await sql(`ANALYZE ${GALAXY_TABLE}`);
    },
    async close() {
      buffer = [];
      await client.end().catch(() => undefined);
    },
  };
}

/** Порядок строк внутри пачки для тестов схлопывания (как в INSERT-пути). */
export const supersedes = galaxyRowSupersedes;
