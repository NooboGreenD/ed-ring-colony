import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPI_FLOW_TTL_SECONDS,
  buildCapiRedirect,
  parseCookies,
  readCookie,
  safeEqual,
  signLinkState,
  verifyLinkState,
} from '../../src/lib/capi/linkState.ts';
import {
  missingColumnFromError,
  schemaWarning,
  updateResilient,
  upsertResilient,
} from '../../src/lib/capi/persist.ts';
import { capiReasonText } from '../../src/lib/capi/messages.ts';

/* ── Cookie потока авторизации ──────────────────────────────────────────
   Колбэк читал cookie регуляркой по всему заголовку: чужое имя с нужным
   окончанием подходило под шаблон, а процентное кодирование не снималось —
   верификатор PKCE как раз заканчивается на «=» и всегда кодируется.
   ────────────────────────────────────────────────────────────────────── */

test('cookie разбираются по точному имени и с декодированием', () => {
  const header = 'sb-access-token=abc; capi_state=st%3D8; xcapi_state=fake; capi_pkce=verifier%3D';
  const jar = parseCookies(header);

  assert.equal(jar.capi_state, 'st=8');
  assert.equal(jar.capi_pkce, 'verifier=', '«=» верификатора PKCE обязано сохраниться');
  assert.equal(jar.xcapi_state, 'fake');
  assert.equal(readCookie(header, 'capi_state'), 'st=8', 'чужая cookie с тем же окончанием не подменяет нашу');
  assert.equal(readCookie('', 'capi_state'), null);
});

test('state сравнивается строго', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, 'abc'), false);
  assert.equal(safeEqual('', ''), false, 'пустое значение не считается совпадением');
});

test('на авторизацию у Frontier отводится полчаса', () => {
  // Вход с подтверждением по почте в десять минут укладывается не всегда —
  // именно на этом пилоты получали invalid_state, пройдя все шаги.
  assert.equal(CAPI_FLOW_TTL_SECONDS, 1800);
});

/* ── Подписанная привязка пилота ────────────────────────────────────── */

test('подписанная cookie возвращает UUID пилота', () => {
  const signed = signLinkState('user-uuid', 'secret');
  assert.equal(verifyLinkState(signed, 'secret'), 'user-uuid');
});

test('подделанная или просроченная подпись отвергается', () => {
  const signed = signLinkState('user-uuid', 'secret');

  assert.equal(verifyLinkState(signed, 'another-secret'), null, 'чужой секрет');
  assert.equal(verifyLinkState(`${signed}x`, 'secret'), null, 'испорченная подпись');
  assert.equal(verifyLinkState('v1.attacker.99999999999999.sig', 'secret'), null);
  assert.equal(verifyLinkState(null, 'secret'), null);

  const expired = signLinkState('user-uuid', 'secret', 60, Date.now() - 120_000);
  assert.equal(verifyLinkState(expired, 'secret'), null, 'срок истёк');
});

test('без секрета подпись не выдаётся и не принимается', () => {
  assert.equal(signLinkState('user-uuid', ''), null);
  assert.equal(verifyLinkState('v1.user.999.sig', ''), null);
});

/* ── Возврат на страницу с причиной ─────────────────────────────────── */

test('редирект несёт статус, причину и подробность', () => {
  const url = buildCapiRedirect('https://example.test', {
    status: 'partial',
    reason: 'profile_unavailable',
    detail: 'CAPI 418',
    binding: 'linked',
    cmdr: 'Nova',
  });

  assert.equal(url.pathname, '/account/capi');
  assert.equal(url.searchParams.get('status'), 'partial');
  assert.equal(url.searchParams.get('reason'), 'profile_unavailable');
  assert.equal(url.searchParams.get('detail'), 'CAPI 418');
  assert.equal(url.searchParams.get('cmdr'), 'Nova');
});

test('у каждой причины есть текст для пилота', () => {
  const reasons = [
    'not_logged_in', 'invalid_state', 'expired_state', 'missing_code', 'access_denied',
    'token_exchange_failed', 'redirect_uri_missing', 'token_save_failed',
    'profile_unavailable', 'profile_empty', 'profile_save_failed', 'capi_maintenance',
    'already_linked_elsewhere', 'unknown',
  ];
  for (const reason of reasons) {
    const text = capiReasonText(reason);
    assert.ok(text.title.length > 0, reason);
    assert.ok(text.hint.length > 10, reason);
  }
  assert.equal(capiReasonText('что-то новое').title, capiReasonText('unknown').title);
});

/* ── Запись при отставшей схеме базы ────────────────────────────────────
   Миграции применяются отдельным шагом обновления, и на живых стендах база
   регулярно отстаёт. Раньше отсутствие одной колонки (`loan`, `cqc_rank`,
   `frontier_id`) роняло весь upsert — привязка «проходила», а профиль не
   сохранялся вовсе.
   ────────────────────────────────────────────────────────────────────── */

test('имя отсутствующей колонки достаётся из ошибки PostgREST', () => {
  assert.equal(missingColumnFromError({
    code: 'PGRST204',
    message: "Could not find the 'loan' column of 'capi_profiles' in the schema cache",
  }), 'loan');

  assert.equal(missingColumnFromError({
    code: '42703',
    message: 'column "frontier_id" of relation "capi_tokens" does not exist',
  }), 'frontier_id');

  assert.equal(missingColumnFromError({ code: '23505', message: 'duplicate key value' }), null);
  assert.equal(missingColumnFromError(null), null);
});

function storeStub(missing = []) {
  const attempts = [];
  const absent = new Set(missing);
  return {
    attempts,
    from(table) {
      return {
        upsert(values) {
          attempts.push({ table, values: { ...values } });
          const bad = Object.keys(values).find((key) => absent.has(key));
          return Promise.resolve(bad
            ? { error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } }
            : { error: null });
        },
        update(values) {
          return {
            eq() {
              attempts.push({ table, values: { ...values } });
              const bad = Object.keys(values).find((key) => absent.has(key));
              return Promise.resolve(bad
                ? { error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } }
                : { error: null });
            },
          };
        },
      };
    },
  };
}

test('upsert повторяется без колонок, которых нет в базе', async () => {
  const svc = storeStub(['loan', 'cqc_rank']);
  const result = await upsertResilient(svc, 'capi_profiles', {
    user_id: 'u1', cmdr_name: 'Nova', credits: 10, loan: 5, cqc_rank: 1,
  }, { onConflict: 'user_id' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedColumns.sort(), ['cqc_rank', 'loan']);
  // Главное: данные всё-таки записаны, а не потеряны целиком.
  const last = svc.attempts.at(-1).values;
  assert.equal(last.cmdr_name, 'Nova');
  assert.equal(last.credits, 10);
  assert.equal('loan' in last, false);
  assert.match(schemaWarning('capi_profiles', result.droppedColumns), /примените миграции/);
});

test('ключевые колонки не выбрасываются — такую ошибку надо показать', async () => {
  const svc = storeStub(['access_token']);
  const result = await upsertResilient(svc, 'capi_tokens', {
    user_id: 'u1', access_token: 'at', refresh_token: 'rt',
  }, { onConflict: 'user_id', required: ['access_token', 'refresh_token'] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.droppedColumns, []);
  assert.match(result.error.message, /access_token/);
});

test('ошибка не про колонки возвращается как есть', async () => {
  const svc = {
    from: () => ({
      upsert: () => Promise.resolve({ error: { code: '23503', message: 'insert violates foreign key' } }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  const result = await upsertResilient(svc, 'capi_profiles', { user_id: 'u1' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /foreign key/);
});

test('update тоже переживает отсутствующие колонки', async () => {
  const svc = storeStub(['last_error', 'last_error_at']);
  const result = await updateResilient(svc, 'capi_tokens', {
    last_synced_at: '2026-09-27T10:00:00Z', last_error: null, last_error_at: null,
  }, { column: 'user_id', value: 'u1' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedColumns.sort(), ['last_error', 'last_error_at']);
  assert.equal(svc.attempts.at(-1).values.last_synced_at, '2026-09-27T10:00:00Z');
  assert.equal(schemaWarning('capi_tokens', []), null);
});
