#!/usr/bin/env node
/**
 * Применение Galnet-миграций к живой базе + проверка колонок переводов.
 *
 * Зачем: перевод Galnet работает только когда у `galnet_news` (и `news`) есть
 * колонки `title_<lang>` / `body_<lang>`, `translation_status` и т.д. Их
 * добавляет идемпотентная миграция
 * `supabase/migrations/20260915000000_galnet_translations.sql`. На базах,
 * развёрнутых до её появления (install.sh заливал снимок full_schema.sql и
 * каталог migrations не прогонял), этих колонок нет — статьи вставляются в
 * «минимальном» режиме, а очередь переводов падает. Обновление через панель
 * применяет только миграции, добавленные МЕЖДУ ревизиями, поэтому старую базу
 * этот файл сам не починит — нужен разовый запуск:
 *
 *   node --env-file=.env.production scripts/apply-galnet-migration.mjs          # применить + проверить
 *   node scripts/apply-galnet-migration.mjs --status                            # только показать состояние
 *   node scripts/apply-galnet-migration.mjs --file 20260920000000_site_content_translations.sql
 *   node scripts/apply-galnet-migration.mjs --url postgresql://postgres:ПАРОЛЬ@db:5432/postgres
 *
 * Подключение: DATABASE_URL или SUPABASE_DB_URL из окружения (тот же ключ,
 * что использует импорт каталога Spansh). Хост должен быть виден оттуда, где
 * запущен скрипт: с сервера это `docker exec -i supabase-db psql ...`, из
 * контейнера web — `db:5432` (см. SPANSH-IMPORT.md, «EAI_AGAIN»).
 *
 * Требуется Node >= 22.18 (type stripping для общего TS-модуля pgModule).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  connectPgClient,
  describePgConnectionError,
  galaxyDbUrl,
  isPgConnectionError,
} from '../src/lib/pgModule.ts';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const DEFAULT_MIGRATIONS = [
  '20260830152500_galnet_news.sql',           // CREATE TABLE IF NOT EXISTS — безопасно на любой базе
  '20260915000000_galnet_translations.sql',   // колонки переводов + служебные поля
];

const TRANSLATION_COLUMNS = [
  'guid', 'slug', 'source_lang', 'translation_status', 'translated_at',
  ...['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'].flatMap((lang) => [`title_${lang}`, `body_${lang}`]),
];

function parseArgs(argv) {
  const args = { file: null, url: '', status: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--status') args.status = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--url') args.url = argv[++i] || '';
    else if (value.startsWith('--url=')) args.url = value.slice('--url='.length);
    else if (value === '--file') args.file = argv[++i] || '';
    else if (value.startsWith('--file=')) args.file = value.slice('--file='.length);
    else if (!value.startsWith('--')) args.file = value;
    else {
      throw new Error(`Неизвестный флаг: ${value} (см. --help)`);
    }
  }
  return args;
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(не похоже на postgres:// URL)';
  }
}

function say(line) {
  console.log(`[galnet-migrate] ${line}`);
}

function die(message, detail) {
  console.error(`[galnet-migrate] ОШИБКА: ${message}`);
  if (detail) console.error(`[galnet-migrate] ${detail}`);
  process.exit(1);
}

async function inspectColumns(client) {
  const tables = ['galnet_news', 'news', 'galnet_sync_log'];
  const result = { tables: {} };
  for (const table of tables) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    if (exists.rowCount === 0) {
      result.tables[table] = { exists: false, columns: [] };
      continue;
    }
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    result.tables[table] = { exists: true, columns: columns.rows.map((row) => String(row.column_name)) };
  }

  if (result.tables.galnet_news?.exists) {
    const statuses = await client.query(
      `SELECT COALESCE(translation_status, 'null') AS status, count(*)::int AS count
         FROM public.galnet_news GROUP BY 1 ORDER BY 2 DESC`,
    ).catch(() => null);
    if (statuses) result.galnetStatuses = statuses.rows.map((row) => `${row.status}: ${row.count}`);
    const total = await client.query('SELECT count(*)::int AS count FROM public.galnet_news').catch(() => null);
    if (total) result.galnetTotal = total.rows[0]?.count ?? 0;
  }
  return result;
}

function reportStatus(state) {
  for (const [table, info] of Object.entries(state.tables)) {
    if (!info.exists) {
      say(`${table}: таблицы нет`);
      continue;
    }
    if (table === 'galnet_sync_log') {
      const extended = info.columns.filter((column) => ['duration_ms', 'translated_count', 'updated_count'].includes(column));
      say(`${table}: расширенных колонок ${extended.length}/3 (${extended.join(', ') || 'нет'})`);
      continue;
    }
    const missing = TRANSLATION_COLUMNS.filter((column) => !info.columns.includes(column));
    say(`${table}: колонок переводов ${TRANSLATION_COLUMNS.length - missing.length}/${TRANSLATION_COLUMNS.length}${missing.length ? `, нет: ${missing.join(', ')}` : ''}`);
    if (table === 'galnet_news' && state.galnetTotal != null) {
      say(`${table}: статей всего ${state.galnetTotal} (${(state.galnetStatuses || []).join(', ') || 'статусов нет'})`);
    }
  }
  const galnet = state.tables.galnet_news;
  if (galnet?.exists && !TRANSLATION_COLUMNS.some((column) => !galnet.columns.includes(column))) {
    say('итог: колонки переводов на месте — синхронизация и очередь переводов могут работать');
  } else {
    say('итог: колонки переводов НЕПОЛНЫ — перевод работать не будет, примените миграцию (запуск без --status)');
  }
}

async function openClient(url) {
  try {
    return await connectPgClient({
      connectionString: url,
      connectionTimeoutMillis: 10_000,
      statementTimeoutMs: 120_000,
      log: (line) => say(line),
    });
  } catch (error) {
    const failure = isPgConnectionError(error)
      ? error.failure
      : describePgConnectionError(error, url);
    die(`прямое подключение к Postgres не удалось: ${failure.message}`);
    return null; // unreachable
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error?.message || String(error));
    return;
  }
  if (args.help) {
    say('usage: node scripts/apply-galnet-migration.mjs [--status] [--file <migration.sql>] [--url <postgres-url>]');
    say('  по умолчанию применяет 20260830152500_galnet_news.sql + 20260915000000_galnet_translations.sql');
    return;
  }

  const url = args.url || galaxyDbUrl();
  if (!url) {
    die(
      'не задан DATABASE_URL / SUPABASE_DB_URL (--url). ' +
      'Для прямой записи нужен Postgres-URL: postgresql://postgres:ПАРОЛЬ@ХОСТ:5432/postgres',
    );
  }
  say(`подключение: ${maskUrl(url)}`);
  const client = await openClient(url);

  try {
    const before = await inspectColumns(client);
    if (args.status) {
      reportStatus(before);
      return;
    }

    const files = args.file
      ? [args.file.includes('/') || args.file.endsWith('.sql') === false ? path.join(MIGRATIONS_DIR, args.file) : args.file]
      : DEFAULT_MIGRATIONS.map((name) => path.join(MIGRATIONS_DIR, name));

    for (const file of files) {
      const base = path.basename(file);
      let sql;
      try {
        sql = await readFile(file, 'utf8');
      } catch {
        die(`файл миграции не найден: ${file}`);
      }
      say(`применяю ${base} (${sql.length} байт)…`);
      try {
        // node-postgres без параметров использует simple protocol —
        // многооператорные файлы выполняются целиком (psql-совместимо).
        await client.query(sql);
      } catch (error) {
        const message = error?.message || String(error);
        if (/already exists/i.test(message)) {
          say(`  ${base}: объекты уже существуют — миграция идемпотентна, пропускаю эту ошибку`);
        } else {
          die(`миграция ${base} упала: ${message}`);
        }
      }
      say(`  ${base}: готово`);
    }

    const after = await inspectColumns(client);
    say('состояние после применения:');
    reportStatus(after);
  } finally {
    try { await client.end(); } catch { /* best effort */ }
  }
}

main().catch((error) => die(error?.stack || error?.message || String(error)));
