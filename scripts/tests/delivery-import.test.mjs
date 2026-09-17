import test from 'node:test';
import assert from 'node:assert/strict';

import { persistImportedDeliveries, DELIVERY_IMPORT_WRITE_BATCH_SIZE } from '../../src/lib/deliveryImport.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Mock Supabase-клиента: записывает каждый запрос, чтобы тест мог проверить
   и результат, и то, КАКИЕ именно statements ушли в базу.
   ────────────────────────────────────────────────────────────────────────── */

/** Ошибка Postgres при превышении statement_timeout (SQLSTATE 57014). */
const STATEMENT_TIMEOUT = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
};

function createMockClient(options = {}) {
  const calls = [];
  const state = {
    insertedRows: [],
    /** Сколько раз запрос existing-hash должен упасть таймаутом. */
    existingTimeoutsLeft: options.existingTimeouts ?? 0,
    /** При каком размере пачки запись начинает успевать. */
    maxRowsBeforeTimeout: options.maxRowsBeforeTimeout ?? Infinity,
    /** Есть ли уникальный индекс под ON CONFLICT. */
    uniqueIndex: options.uniqueIndex ?? false,
    /** Есть ли колонки transport-scope. */
    transportColumns: options.transportColumns ?? true,
  };

  const finish = (builder, result) => {
    builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };

  function tableBuilder(table, spec) {
    const builder = {
      select: (columns) => {
        spec.columns = columns;
        return builder;
      },
      eq: (column, value) => {
        (spec.filters ??= []).push({ op: 'eq', column, value });
        return builder;
      },
      in: (column, values) => {
        (spec.filters ??= []).push({ op: 'in', column, values });
        return builder;
      },
      not: (column, op, value) => {
        (spec.filters ??= []).push({ op: `not.${op}`, column, value });
        return builder;
      },
      insert: (rows) => {
        spec.rows = rows;
        spec.mode = 'insert';
        return builder;
      },
      upsert: (rows, opts) => {
        spec.rows = rows;
        spec.mode = 'upsert';
        spec.onConflict = opts?.onConflict;
        return builder;
      },
      maybeSingle: () => {
        spec.single = true;
        return builder;
      },
    };
    return builder;
  }

  const client = {
    calls,
    state,
    from(table) {
      const spec = { table };
      calls.push(spec);
      const builder = tableBuilder(table, spec);
      // Терминальный вызов: PostgREST-запросы в этом коде завершаются `.select('id')`
      // после мутации, либо thenable-ожиданием после `.eq()/.in()`.
      const run = () => {
        if (table === 'deliveries' && spec.rows) {
          const rows = spec.rows;
          if (spec.mode === 'upsert' && spec.onConflict && !state.uniqueIndex) {
            return { data: null, error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
          }
          if (rows.length > state.maxRowsBeforeTimeout) {
            return { data: null, error: STATEMENT_TIMEOUT };
          }
          state.insertedRows.push(...rows);
          return { data: rows.map((_row, index) => ({ id: state.insertedRows.length + index })), error: null };
        }
        if (table === 'deliveries' && spec.columns === 'source_hash') {
          if (state.existingTimeoutsLeft > 0) {
            state.existingTimeoutsLeft -= 1;
            return { data: null, error: STATEMENT_TIMEOUT };
          }
          return { data: [], error: null };
        }
        return { data: [], error: null };
      };
      return finish(builder, undefined) && Object.assign(builder, {
        then: (resolve, reject) => {
          try { resolve(run()); } catch (error) { reject(error); }
        },
      });
    },
    async rpc(name, params) {
      const spec = { table: 'rpc', rpc: name, params };
      calls.push(spec);
      return { data: [], error: null };
    },
  };
  return client;
}

/** Минимальная валидная доставка для `validRows`. */
function delivery(index, system = 'Delta Velorum') {
  return {
    system_name: system,
    commodity: 'Tritium',
    amount: 10 + index,
    timestamp: `2026-09-14T10:00:${String(index % 60).padStart(2, '0')}Z`,
    source_hash: `h-${index}`,
    source: 'contribution',
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Запрос существующих хешей обязан попадать в partial-индекс.
   ────────────────────────────────────────────────────────────────────────── */

test('запрос существующих хешей явно требует source_hash IS NOT NULL', async () => {
  // Индекс в БД частичный: `... (user_id, source_hash) WHERE source_hash IS NOT NULL`.
  // Планировщик использует частичный индекс, только если предикат индекса
  // выводится из предиката запроса. Выводить `IS NOT NULL` из `IN (константы)`
  // Postgres не обязан, поэтому без явного фильтра запрос рискует уйти в
  // seq scan по всей таблице deliveries — это и есть источник
  // «canceling statement due to statement timeout» на большой истории.
  const client = createMockClient();
  await persistImportedDeliveries(client, 'user-1', [delivery(1), delivery(2)]);

  const existingCall = client.calls.find(
    (call) => call.table === 'deliveries' && call.columns === 'source_hash',
  );
  assert.ok(existingCall, 'запрос существующих хешей не выполнялся');

  const notNull = (existingCall.filters ?? []).find(
    (filter) => filter.column === 'source_hash' && filter.op === 'not.is' && filter.value === null,
  );
  assert.ok(
    notNull,
    'запрос не содержит явного `source_hash IS NOT NULL` — частичный индекс может не примениться',
  );
});

/* ──────────────────────────────────────────────────────────────────────────
   Таймаут базы не должен обрывать весь импорт.
   ────────────────────────────────────────────────────────────────────────── */

test('таймаут statement на пачке не роняет весь импорт', async () => {
  // Сценарий из бага: первые пакеты проходят, затем база перестаёт успевать.
  // Импорт обязан уменьшать пачку и дописать остаток, а не отдавать 500,
  // из-за которого клиент теряет весь прогресс загрузки журнала.
  const client = createMockClient({ maxRowsBeforeTimeout: 10 });

  const rows = Array.from({ length: DELIVERY_IMPORT_WRITE_BATCH_SIZE }, (_unused, index) => delivery(index));
  const outcome = await persistImportedDeliveries(client, 'user-1', rows);

  assert.equal(outcome.eventsFound, rows.length, 'не все события учтены');
  assert.equal(
    outcome.inserted, rows.length,
    'после таймаута часть доставок потеряна вместо перезаписи меньшей пачкой',
  );
  assert.equal(client.state.insertedRows.length, rows.length, 'в базу легло не всё');
});

test('импорт продолжает следующие чанки после таймаута в одном из них', async () => {
  // Таймаут в первом запросе existing-hash не должен отменять остальные чанки.
  const client = createMockClient({ existingTimeouts: 1 });

  const size = DELIVERY_IMPORT_WRITE_BATCH_SIZE;
  const rows = Array.from({ length: size * 3 }, (_unused, index) => delivery(index));
  const outcome = await persistImportedDeliveries(client, 'user-1', rows);

  assert.equal(outcome.eventsFound, rows.length, 'учтены не все события');
  assert.equal(client.state.insertedRows.length, rows.length, 'в базу легли не все чанки');
});
