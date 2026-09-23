import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { parse, parsePlPgSQL } = require('libpg-query');

/* ──────────────────────────────────────────────────────────────────────────
   SQL-файлы репозитория проверяются настоящим грамматическим разборщиком
   PostgreSQL (libpg_query — тот же парсер, что в ядре). Миграции применяются
   на сервере через `psql -v ON_ERROR_STOP=1`, то есть первая же опечатка
   останавливает обновление проекта; дешевле поймать её здесь.

   Проверяется синтаксис, а не семантика: наличие расширения/оператора и план
   запроса парсер не видит (см. SPANSH-IMPORT.md → «Масштаб»).
   ────────────────────────────────────────────────────────────────────────── */

const ROOT = new URL('../..', import.meta.url).pathname;

function sqlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sqlFiles(full));
    else if (entry.endsWith('.sql')) out.push(full);
  }
  return out.sort();
}

const FILES = sqlFiles(join(ROOT, 'supabase'));

test('SQL-файлы supabase/ находятся', () => {
  assert.ok(FILES.length > 40, `найдено ${FILES.length} файлов`);
  assert.ok(FILES.some((f) => f.endsWith('20260925000000_galaxy_systems_scale.sql')));
});

test('миграция переводов Galnet покрывает все языки translate.mjs для galnet_news и news', () => {
  const migration = readFileSync(
    join(ROOT, 'supabase', 'migrations', '20260915000000_galnet_translations.sql'),
    'utf8',
  );
  // Список языков — тот же, что используют sync/перевод и сайт.
  const langs = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];
  const missing = [];
  for (const table of ['galnet_news', 'news']) {
    for (const lang of langs) {
      for (const field of ['title', 'body']) {
        const column = `ADD COLUMN IF NOT EXISTS ${field}_${lang} TEXT`;
        // Колонки galnet_news добавляются на верхнем уровне, news — внутри DO $$.
        if (!migration.includes(column)) missing.push(`${table}.${field}_${lang}`);
      }
    }
    for (const extra of ['translation_status', 'translated_at']) {
      // У galnet_news есть и source_lang; для news достаточно статуса и даты.
      if (!migration.includes(`ADD COLUMN IF NOT EXISTS ${extra}`)) missing.push(`${table}.${extra}`);
    }
  }
  assert.deepEqual(missing, [], 'колонки без которых перевод Galnet не работает');
  // Служебные поля таблицы лога, которые пишет синк.
  for (const column of ['duration_ms', 'translated_count', 'updated_count']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`), `galnet_sync_log.${column}`);
  }
});

test('каждый SQL-файл разбирается парсером PostgreSQL', async () => {
  const failures = [];
  for (const file of FILES) {
    const sql = readFileSync(file, 'utf8');
    try {
      await parse(sql);
    } catch (error) {
      failures.push(`${relative(ROOT, file)}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, [], 'файлы с синтаксическими ошибками');
});

test('тела SQL-функций в $fn$-кавычках разбираются отдельно', async () => {
  // Для внешнего парсера тело функции — строка: его ошибки он не видит.
  const failures = [];
  let bodies = 0;
  for (const file of FILES) {
    const sql = readFileSync(file, 'utf8');
    for (const [index, match] of [...sql.matchAll(/\$fn\$\s*([\s\S]*?)\$fn\$/g)].entries()) {
      bodies++;
      try {
        await parse(match[1]);
      } catch (error) {
        failures.push(`${relative(ROOT, file)} [тело ${index + 1}]: ${error.message}`);
      }
    }
  }
  assert.ok(bodies >= 2, `проверено тел функций: ${bodies}`);
  assert.deepEqual(failures, []);
});

/**
 * Тела DO из дерева разбора: регуляркой границы $…$-кавычек не найти.
 * libpg_query 18 кладёт тело в DoStmt.args[].DefElem(arg=as).arg.String.sval.
 */
function doBlocks(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) doBlocks(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'DoStmt' && Array.isArray(value?.args)) {
      for (const arg of value.args) {
        const element = arg?.DefElem;
        if (element?.defname === 'as' && typeof element?.arg?.String?.sval === 'string') {
          out.push(element.arg.String.sval);
        }
      }
      continue;
    }
    doBlocks(value, out);
  }
  return out;
}

test('блоки DO разбираются как plpgsql', async () => {
  const failures = [];
  let blocks = 0;
  for (const file of FILES) {
    let tree;
    try {
      tree = await parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // синтаксис файла проверяет отдельный тест
    }
    for (const [index, body] of doBlocks(tree).entries()) {
      // В исторических сидах wiki внутри блока лежат собственные $c$/$nl$-строки:
      // обёртка для parsePlPgSQL на них ломается, а сам файл парсер уже принял.
      if (/\$[A-Za-z_]*\$/.test(body)) continue;
      blocks++;
      const wrapped = `CREATE FUNCTION _sqlcheck_${index}() RETURNS void AS $wrap$${body}$wrap$ LANGUAGE plpgsql`;
      try {
        await parsePlPgSQL(wrapped);
      } catch (error) {
        failures.push(`${relative(ROOT, file)} [DO ${index + 1}]: ${error.message}`);
      }
    }
  }
  assert.ok(blocks >= 3, `проверено блоков DO: ${blocks}`);
  assert.deepEqual(failures, []);
});

/* ── Миграция масштаба: содержательные проверки, а не только синтаксис ── */

const SCALE = readFileSync(join(ROOT, 'supabase/migrations/20260925000000_galaxy_systems_scale.sql'), 'utf8');
const MAINTENANCE = readFileSync(
  join(ROOT, 'supabase/maintenance/galaxy_systems_spatial_index.sql'),
  'utf8',
);

test('миграция масштаба строит GiST по cube и переписывает функции Атласа', () => {
  assert.match(SCALE, /CREATE EXTENSION IF NOT EXISTS cube/);
  assert.match(SCALE, /USING gist \(cube\(ARRAY\[x, y, z\]\)\)/);
  assert.match(SCALE, /CREATE OR REPLACE FUNCTION public\.galaxy_star_candidates/);
  assert.match(SCALE, /CREATE OR REPLACE FUNCTION public\.galaxy_systems_near/);
  // KNN-сортировка тем же выражением, что в индексе, — иначе индекс не применится.
  assert.match(SCALE, /ORDER BY cube\(ARRAY\[g\.x, g\.y, g\.z\]\) <-> cube\(ARRAY\[cx, cy, cz\]\)/);
  assert.match(SCALE, /cube\(ARRAY\[g\.x, g\.y, g\.z\]\) && cube\(/);
});

test('устаревшие индексы удаляются только после создания GiST', () => {
  const dropAt = SCALE.indexOf('DROP INDEX IF EXISTS public.idx_galaxy_systems_x');
  const guardAt = SCALE.indexOf('IF spatial_ready THEN');
  assert.ok(guardAt > 0 && dropAt > guardAt, 'удаление внутри условия spatial_ready');
  for (const name of ['x', 'y', 'z', 'star_type', 'star_giant_class']) {
    assert.match(SCALE, new RegExp(`DROP INDEX IF EXISTS public\\.idx_galaxy_systems_${name};`));
  }
  // Уникальные индексы апсерта трогать нельзя.
  assert.ok(!SCALE.includes('uq_galaxy_systems_id64'));
  assert.ok(!SCALE.includes('uq_galaxy_systems_name_lc'));
});

test('на большой таблице индекс не строится внутри миграции', () => {
  // CREATE INDEX на 10⁸ строк держит блокировку записи часами — его место в
  // maintenance-скрипте с CONCURRENTLY.
  assert.match(SCALE, /total_rows < 5000000/);
  assert.ok(!SCALE.includes('CONCURRENTLY'), 'в миграции нет CONCURRENTLY');
  assert.match(MAINTENANCE, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_galaxy_systems_coord/);
  assert.match(MAINTENANCE, /DROP INDEX CONCURRENTLY IF EXISTS public\.idx_galaxy_systems_x/);
  assert.match(MAINTENANCE, /ANALYZE public\.galaxy_systems/);
});

test('autovacuum и fillfactor настроены под большую таблицу', () => {
  assert.match(SCALE, /fillfactor = 100/);
  assert.match(SCALE, /autovacuum_vacuum_scale_factor = 0\.01/);
  assert.match(SCALE, /autovacuum_analyze_scale_factor = 0\.002/);
});
