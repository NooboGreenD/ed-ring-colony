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
    /** source_hash строк, которые база не принимает даже по одной. */
    timeoutHashes: options.timeoutHashes ?? [],
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
          if (rows.some((row) => (state.timeoutHashes ?? []).includes(row.source_hash))) {
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

/* ──────────────────────────────────────────────────────────────────────────
   Регрессия собственного адаптивного деления: поиск размещений не должен
   выполняться повторно для каждой половины пачки.
   ────────────────────────────────────────────────────────────────────────── */

test('адаптивное деление не умножает поиск размещений', async () => {
  // `loadPlacementLookup` ходит в hubs/route_systems, где на точное имя
  // индекса может не быть вовсе. Если при делении пачки пополам искать
  // размещения заново для каждой половины, дорогой запрос выполняется
  // вместо одного раза несколько — и таймаут не уходит, а усугубляется.
  const client = createMockClient({ maxRowsBeforeTimeout: 4 });

  // Система уникальна для этого теста: кэш размещений живёт на уровне модуля,
  // и на уже встречавшемся имени обращений к базе не будет вовсе.
  const rows = Array.from({ length: DELIVERY_IMPORT_WRITE_BATCH_SIZE },
    (_unused, index) => delivery(index, 'Adaptive Split Probe System'));
  await persistImportedDeliveries(client, 'user-1', rows);

  const placementCalls = client.calls.filter(
    (call) => call.rpc === 'resolve_delivery_system_placements'
      || (call.table === 'hubs' || call.table === 'route_systems'),
  ).length;

  assert.equal(
    placementCalls, 1,
    `поиск размещений выполнен ${placementCalls} раз вместо одного — деление пачки умножает дорогой запрос`,
  );
});

test('неразрешимый таймаут откладывает одну строку, а не весь чанк', async () => {
  // Если база не принимает конкретную строку даже отдельно, раньше из-за неё
  // откладывался весь чанк: соседние записываемые доставки терялись вместе с
  // проблемной. Откладываться должна ровно проблемная строка.
  const size = DELIVERY_IMPORT_WRITE_BATCH_SIZE;
  const rows = Array.from({ length: size * 3 }, (_unused, index) => delivery(index));
  const poisoned = rows[size + 3].source_hash;

  const client = createMockClient({ timeoutHashes: [poisoned] });
  const outcome = await persistImportedDeliveries(client, 'user-1', rows);

  assert.equal(outcome.deferred, 1, 'отложено больше, чем одна проблемная строка');
  assert.equal(outcome.inserted, rows.length - 1, 'соседние строки потеряны вместе с проблемной');
  assert.equal(client.state.insertedRows.length, rows.length - 1, 'в базу легло не всё, что могло');
  assert.equal(outcome.eventsFound, rows.length, 'учтены не все события');
});

test('импорт больше не отвечает 500 на таймаут базы', async () => {
  // Собственно баг из отчёта: 500 → клиент трижды повторял пакет → обрыв
  // загрузки на 30-м пакете из 500+. Таймаут обязан оставаться внутри импорта.
  const client = createMockClient({ maxRowsBeforeTimeout: 0 });

  const rows = Array.from({ length: DELIVERY_IMPORT_WRITE_BATCH_SIZE * 4 }, (_unused, index) => delivery(index));
  const outcome = await persistImportedDeliveries(client, 'user-1', rows);

  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.deferred, rows.length, 'ничего не записано — всё должно быть отложено, а не брошено');
});

test('повторная загрузка тех же систем не ходит в базу за размещениями', async () => {
  // В журнале одни и те же системы повторяются сотни раз. Поиск размещения —
  // самая дорогая часть импорта, поэтому между пачками он обязан кэшироваться,
  // иначе загрузка из 500+ пакетов упирается в statement_timeout.
  const system = 'Cached Placement System';
  const first = createMockClient();
  await persistImportedDeliveries(first, 'user-1', [delivery(1, system), delivery(2, system)]);
  const firstCalls = first.calls.filter(
    (call) => call.rpc === 'resolve_delivery_system_placements' || call.table === 'hubs',
  ).length;
  assert.ok(firstCalls > 0, 'первая загрузка должна была сходить в базу');

  const second = createMockClient();
  await persistImportedDeliveries(second, 'user-2', [delivery(3, system), delivery(4, system)]);
  const secondCalls = second.calls.filter(
    (call) => call.rpc === 'resolve_delivery_system_placements' || call.table === 'hubs',
  ).length;
  assert.equal(secondCalls, 0, 'размещения запрошены заново вместо использования кэша');
});
