import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { parse, parsePlPgSQL, scan } = require('libpg-query');

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

/**
 * Миграции, которые намеренно ничего не делают или пока не работают.
 * Первый файл — шаблон для ручного запуска, второй — заметка о заливке через
 * Management API. Остальные четыре — та же поломка формата, что и в
 * 20260903000000_wiki_fill_empty_categories.sql: код съеден комментарием, файл
 * надо восстановить (см. SQL-MIGRATIONS-AUDIT.md). Если файл починили — уберите
 * его отсюда, тест об этом напомнит.
 */
const KNOWN_DEAD = new Map([
  ['20260902010000_wiki_colonization_guide.sql', 'шаблон-инструкция для ручного запуска в SQL Editor'],
  ['20260908020000_wiki_exobiology_update.sql', 'заметка: контент залит через Management API'],
  ['20260830152500_galnet_news.sql', 'формат потерян: комментарий съел таблицу galnet_news'],
  ['20260903010000_wiki_update_colonization.sql', 'формат потерян: комментарий съел 3 статьи'],
  ['20260903020000_wiki_lore_articles.sql', 'формат потерян: комментарий съел 5 статей'],
  ['20260904100000_system_coords_cache.sql', 'формат потерян: комментарий съел таблицу system_coords'],
]);

/**
 * supabase/full_schema.sql — снимок, собранный из тех же миграций: пока в них
 * лежат потерявшие формат копии, дефект виден и здесь, поэтому проверяются
 * сами миграции. Снимок пересобирают после их починки.
 */
const SNAPSHOT_FILES = new Set(['full_schema.sql']);

const formatDamaged = (file) =>
  KNOWN_DEAD.has(basename(file)) || SNAPSHOT_FILES.has(basename(file));

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
 * Внутренние $-кавычки тела DO ($c$…$c$ — тексты статей) заменяются на
 * короткий строковый литерал. Для разбора plpgsql их содержимое не важно, а
 * обёртка тела в отдельный тег на вложенных кавычках спотыкалась — раньше из-за
 * этого тела сидов wiki вообще не проверялись.
 * Возвращает null, если кавычки не сбалансированы (тогда тело не проверяем).
 */
function maskDollarQuoted(body) {
  let out = '';
  let masked = 0;
  let i = 0;
  while (i < body.length) {
    const tag = /^\$[A-Za-z_0-9]*\$/.exec(body.slice(i));
    if (!tag) {
      out += body[i];
      i += 1;
      continue;
    }
    const end = body.indexOf(tag[0], i + tag[0].length);
    if (end === -1) return null;
    out += " '<content>' ";
    masked += 1;
    i = end + tag[0].length;
  }
  return { body: out, masked };
}

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
  let unparsed = 0;
  for (const file of FILES) {
    if (formatDamaged(file)) continue; // известные дефекты формата — см. KNOWN_DEAD
    let tree;
    try {
      tree = await parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // синтаксис файла проверяет отдельный тест
    }
    for (const [index, raw] of doBlocks(tree).entries()) {
      const masked = maskDollarQuoted(raw);
      if (!masked) {
        unparsed += 1;
        continue;
      }
      blocks += 1;
      const wrapped = `CREATE FUNCTION _sqlcheck_${index}() RETURNS void AS $wrap$${masked.body}$wrap$ LANGUAGE plpgsql`;
      try {
        await parsePlPgSQL(wrapped);
      } catch (error) {
        failures.push(`${relative(ROOT, file)} [DO ${index + 1}]: ${error.message}`);
      }
    }
  }
  assert.ok(blocks >= 12, `проверено блоков DO: ${blocks} (не разобрано: ${unparsed})`);
  assert.deepEqual(failures, []);
});

/* ── Формат файлов: миграция не должна «теряться» целиком ── */

test('ни один комментарий не съедает код', async () => {
  // Миграция, сохранённая без переводов строк, ломается молча: первый же «-- …»
  // превращает в комментарий весь остаток файла вместе с DO-блоком (так был
  // испорчен 20260903000000_wiki_fill_empty_categories.sql). Честный
  // комментарий в дереве короткий — самый длинный 228 символов, поэтому
  // длинный токен SQL_COMMENT означает потерянные переводы строк.
  const LIMIT = 400;
  const failures = [];
  for (const file of FILES) {
    if (formatDamaged(file)) continue; // известные дефекты формата — см. KNOWN_DEAD
    const sql = readFileSync(file, 'utf8');
    let tokens;
    try {
      ({ tokens } = await scan(sql));
    } catch {
      continue; // файл без команд сканер может не разобрать — это ловит тест ниже
    }
    for (const token of tokens) {
      if (token.tokenName !== 'SQL_COMMENT') continue;
      const length = token.end - token.start;
      if (length <= LIMIT) continue;
      const line = sql.slice(0, token.start).split('\n').length;
      failures.push(
        `${relative(ROOT, file)}:${line} — комментарий на ${length} символов ` +
          `(«${token.text.slice(0, 60).trim()}…»): файл сохранён без переводов строк?`,
      );
    }
  }
  assert.deepEqual(failures, []);
});

test('каждая миграция содержит хотя бы одну команду', async () => {
  const dead = [];
  for (const file of sqlFiles(join(ROOT, 'supabase', 'migrations'))) {
    const tree = await parse(readFileSync(file, 'utf8'));
    const statements = Array.isArray(tree) ? tree : tree.stmts ?? [];
    if (statements.length === 0) dead.push(basename(file));
  }
  const unexpected = dead.filter((name) => !KNOWN_DEAD.has(name));
  const revived = [...KNOWN_DEAD.keys()].filter((name) => !dead.includes(name));
  assert.deepEqual(unexpected, [], 'эти миграции не выполняют ни одной команды');
  assert.deepEqual(revived, [], 'файлы снова работают — уберите их из KNOWN_DEAD');
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
