/**
 * Тесты оркестрации синхронизации (лента → Supabase → перевод).
 *
 * Сеть и реальная база не нужны: лента подменяется фикстурой,
 * а Supabase — минимальным in-memory клиентом.
 *
 * Запуск:
 *   node --test scripts/tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { syncGalnet, translatePending, GALNET_TABLE } from '../lib/galnet-sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(path.join(here, 'fixtures', 'galnet-feed.json'), 'utf8')
);

/**
 * Минимальный in-memory аналог supabase-js, покрывающий цепочки,
 * которые использует syncGalnet / translatePending.
 */
function createFakeSupabase(initialTables = {}) {
  const tables = new Map();

  for (const [name, rows] of Object.entries(initialTables)) {
    tables.set(
      name,
      rows.map((row, index) => ({ id: row.id ?? index + 1, ...row }))
    );
  }

  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const parseOr = (row, expr) => {
    if (!expr) return true;
    return expr
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => {
        const match = part.match(/^([a-z_]+)\.(in|is|eq)\.(.*)$/i);
        if (!match) return false;
        const [, col, op, raw] = match;
        if (op === 'is') {
          return raw === 'null' ? row[col] === null || row[col] === undefined : false;
        }
        if (op === 'in') {
          const values = raw
            .replace(/[()]/g, '')
            .split(',')
            .map((value) => value.trim());
          return values.includes(String(row[col] ?? ''));
        }
        return String(row[col]) === raw;
      });
  };

  const query = (table) => {
    const state = {
      table,
      mode: null,
      payload: null,
      upsertOptions: null,
      filters: [],
      inFilter: null,
      orExpr: null,
      limit: null,
      orderCol: null,
      head: false,
      countExact: false,
      selectCols: '*',
    };

    const execute = () => {
      const rows = rowsOf(state.table);

      if (state.mode === 'insert') {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        const inserted = list.map((row) => {
          const stored = { id: rows.length + 1, ...row };
          rows.push(stored);
          return stored;
        });
        return { data: inserted, error: null };
      }

      if (state.mode === 'upsert') {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        const conflict = /nid/.test(state.upsertOptions?.onConflict || '') ? 'nid' : 'id';
        const inserted = list.map((row) => {
          const found = rows.find((existing) => String(existing[conflict]) === String(row[conflict]));
          if (found) {
            Object.assign(found, row);
            return found;
          }
          const stored = { id: rows.length + 1, ...row };
          rows.push(stored);
          return stored;
        });
        return { data: inserted, error: null };
      }

      if (state.mode === 'update') {
        const targets = rows.filter((row) =>
          state.filters.every(([col, value]) => String(row[col]) === String(value))
        );
        targets.forEach((row) => Object.assign(row, state.payload));
        return { data: targets, error: null };
      }

      // select
      let result = rows.filter(
        (row) =>
          state.filters.every(([col, value]) => String(row[col]) === String(value)) &&
          (!state.inFilter ||
            state.inFilter.values.some((value) => String(row[state.inFilter.column]) === String(value))) &&
          parseOr(row, state.orExpr)
      );

      if (state.orderCol) {
        const column = state.orderCol.replace(/^-/, '');
        const direction = state.orderCol.startsWith('-') ? -1 : 1;
        result = [...result].sort((a, b) => {
          const av = a[column] ?? '';
          const bv = b[column] ?? '';
          return av > bv ? direction : av < bv ? -direction : 0;
        });
      }

      if (state.countExact || state.head) {
        return { count: result.length, data: null, error: null };
      }

      if (state.limit != null) result = result.slice(0, state.limit);
      return { data: result, error: null };
    };

    const builder = {
      select(cols, options) {
        state.mode = state.mode || 'select';
        if (typeof cols === 'string') state.selectCols = cols;
        state.head = Boolean(options?.head);
        state.countExact = options?.count === 'exact';
        return builder;
      },
      insert(payload) {
        state.mode = 'insert';
        state.payload = payload;
        return builder;
      },
      upsert(payload, options) {
        state.mode = 'upsert';
        state.payload = payload;
        state.upsertOptions = options || null;
        return builder;
      },
      update(payload) {
        state.mode = 'update';
        state.payload = payload;
        return builder;
      },
      eq(column, value) {
        state.filters.push([column, value]);
        return builder;
      },
      in(column, values) {
        state.inFilter = { column, values };
        return builder;
      },
      or(expression) {
        state.orExpr = expression;
        return builder;
      },
      order(column, options) {
        state.orderCol = options?.ascending === false ? `-${column}` : column;
        return builder;
      },
      limit(value) {
        state.limit = value;
        return builder;
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };

    return builder;
  };

  return {
    from: (table) => query(table),
    __tables: tables,
  };
}

/**
 * Подменяет сеть: лента Galnet отдаётся из фикстуры,
 * а «переводчик» Yandex помечает текст префиксом языка.
 */
function fakeFetchFactory({ failTranslateFor = [] } = {}) {
  const translateCalls = [];

  return async function fakeFetch(url, init) {
    const target = String(url);

    if (target.includes('cms.zaonce.net')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(fixture) };
    }

    if (target.includes('translate.api.cloud.yandex.net')) {
      const body = JSON.parse(init.body);
      translateCalls.push({ lang: body.targetLanguageCode, count: body.texts.length });
      if (failTranslateFor.includes(body.targetLanguageCode)) {
        // 403 — неретраибельная ошибка, чтобы тест не ждал бэкофф.
        return {
          ok: false,
          status: 403,
          headers: { get: () => null },
          text: async () => 'Forbidden',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            translations: body.texts.map((text) => ({ text: `[${body.targetLanguageCode}] ${text}` })),
          }),
      };
    }

    throw new Error(`unexpected fetch: ${target}`);
  };
}

process.env.YANDEX_TRANSLATE_API_KEY = 'test-key';
delete process.env.YANDEX_TRANSLATE_IAM_TOKEN;

test.beforeEach(() => {
  process.env.YANDEX_TRANSLATE_API_KEY = 'test-key';
  delete process.env.YANDEX_TRANSLATE_IAM_TOKEN;
});

test.after(() => {
  delete process.env.YANDEX_TRANSLATE_API_KEY;
});

test('syncGalnet вставляет новые статьи и переводит их', async () => {
  const supabase = createFakeSupabase();
  const log = fakeFetchFactory();

  const result = await syncGalnet({ supabase, limit: 30, translateLimit: 10, fetchImpl: log });

  assert.equal(result.ok, true);
  assert.equal(result.fetched, 5, 'из 7 элементов ленты валидны 5');
  assert.equal(result.inserted, 5);
  assert.equal(result.translated, 5);
  assert.deepEqual(result.errors, []);

  const rows = supabase.__tables.get(GALNET_TABLE);
  assert.equal(rows.length, 5);

  const newest = rows.find((row) => row.nid === 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518');
  assert.equal(newest.title, 'Federation Condemns Ongoing October Accords Exclusion');
  assert.equal(newest.published_at, '2026-09-11T14:00:46.000Z');
  assert.equal(newest.translation_status, 'completed');
  assert.ok(newest.translated_at);
  assert.equal(newest.title_ru, `[ru] ${newest.title}`);
  assert.equal(newest.body_ru, `[ru] ${newest.body}`);
  // Оригинал должен быть доступен и в языковой колонке источника.
  assert.equal(newest.title_en, newest.title);
});

test('syncGalnet не дублирует уже известные статьи', async () => {
  const supabase = createFakeSupabase({
    [GALNET_TABLE]: [
      {
        nid: 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518',
        title: 'Federation Condemns Ongoing October Accords Exclusion',
        body: 'President Felicia Winters held a conference today condemning the continued exclusion of the Federation.\n"The evidence presented to me has concluded that those involved with the October Accords pose a credible threat," she said.\n"We can only assume that we are now a target."',
        published_at: '2026-09-11T14:00:46.000Z',
        translation_status: 'completed',
        translated_at: '2026-09-11T15:00:00.000Z',
      },
    ],
  });

  const result = await syncGalnet({ supabase, limit: 30, fetchImpl: fakeFetchFactory() });

  assert.equal(result.inserted, 4, 'известная статья не должна вставляться повторно');
  assert.equal(result.unchanged, 1);
  assert.equal(supabase.__tables.get(GALNET_TABLE).length, 5);
});

test('syncGalnet пере-переводит статью, если Frontier изменил текст', async () => {
  const supabase = createFakeSupabase({
    [GALNET_TABLE]: [
      {
        nid: 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518',
        title: 'Old title',
        body: 'Old body',
        published_at: '2026-09-11T14:00:46.000Z',
        translation_status: 'completed',
        translated_at: '2026-09-11T15:00:00.000Z',
      },
    ],
  });

  const result = await syncGalnet({ supabase, limit: 30, fetchImpl: fakeFetchFactory() });

  assert.equal(result.updated, 1);
  const row = supabase.__tables
    .get(GALNET_TABLE)
    .find((item) => item.nid === 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518');
  assert.equal(row.title, 'Federation Condemns Ongoing October Accords Exclusion');
  assert.equal(row.translation_status, 'completed');
});

test('syncGalnet пишет лог синхронизации', async () => {
  const supabase = createFakeSupabase();
  await syncGalnet({ supabase, limit: 30, fetchImpl: fakeFetchFactory() });

  const logRows = supabase.__tables.get('galnet_sync_log') || [];
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].status, 'success');
  assert.equal(logRows[0].articles_count, 5);
  assert.equal(logRows[0].new_count, 5);
});

test('syncGalnet сообщает об ошибке, если лента недоступна', async () => {
  const supabase = createFakeSupabase();
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' });

  const result = await syncGalnet({ supabase, limit: 30, fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /503/);
  assert.equal(supabase.__tables.get(GALNET_TABLE)?.length ?? 0, 0);
});

test('сбой одного языка не отменяет остальные переводы', async () => {
  const supabase = createFakeSupabase();
  const fetchImpl = fakeFetchFactory({ failTranslateFor: ['de'] });

  const result = await syncGalnet({ supabase, limit: 30, fetchImpl, translateLimit: 3 });

  assert.equal(result.translated, 3, 'перевод считается успешным при частичном успехе');
  assert.equal(result.translationFailed, 0);

  const rows = supabase.__tables.get(GALNET_TABLE);
  const withRu = rows.filter((row) => row.title_ru);
  assert.ok(withRu.length >= 3);
  assert.ok(
    rows.some((row) => row.translation_status === 'partial'),
    'статус должен быть partial'
  );
  assert.ok(
    result.errors.some((error) => error.includes('de:')),
    'ошибка по немецкому должна попасть в отчёт'
  );
});

test('перевод пропускается, если нет ключей API — статьи остаются pending', async () => {
  const original = process.env.YANDEX_TRANSLATE_API_KEY;
  delete process.env.YANDEX_TRANSLATE_API_KEY;

  try {
    const supabase = createFakeSupabase();
    const result = await syncGalnet({ supabase, limit: 30, fetchImpl: fakeFetchFactory() });

    assert.equal(result.inserted, 5, 'статьи всё равно должны сохраниться');
    assert.equal(result.translated, 0);
    assert.ok(result.errors.some((error) => error.includes('YANDEX_TRANSLATE_API_KEY')));

    const rows = supabase.__tables.get(GALNET_TABLE);
    assert.ok(rows.every((row) => row.translation_status === 'pending'));
  } finally {
    if (original !== undefined) process.env.YANDEX_TRANSLATE_API_KEY = original;
  }
});

test('translatePending догоняет очередь и считает остаток', async () => {
  const supabase = createFakeSupabase({
    [GALNET_TABLE]: [
      { id: 1, nid: 'a', title: 'One', body: 'One body', translation_status: 'pending' },
      { id: 2, nid: 'b', title: 'Two', body: 'Two body', translation_status: 'failed' },
      { id: 3, nid: 'c', title: 'Three', body: 'Three body', translation_status: 'completed', translated_at: 'x' },
    ],
  });

  const result = await translatePending({
    supabase,
    tables: [GALNET_TABLE],
    limit: 2,
    fetchImpl: fakeFetchFactory(),
  });

  assert.equal(result.translated, 2);
  assert.equal(result.failed, 0);

  const rows = supabase.__tables.get(GALNET_TABLE);
  assert.equal(rows.find((row) => row.id === 1).translation_status, 'completed');
  assert.equal(rows.find((row) => row.id === 2).translation_status, 'completed');
  // Завершённая статья не должна трогаться.
  assert.equal(rows.find((row) => row.id === 3).title_ru, undefined);
});
