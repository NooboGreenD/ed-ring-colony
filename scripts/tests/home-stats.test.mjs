import test from 'node:test';
import assert from 'node:assert/strict';
import { importBundle } from './helpers/bundle.mjs';

const translations = await importBundle({ entry: 'src/lib/i18n/translations.ts' });
const api = await importBundle({
  entry: 'src/app/api/home-data/route.ts',
  stubs: {
    'next/server': `export const NextResponse = { json: (body, options = {}) => ({ body, options }) };`,
    '@/lib/supabaseServer': `export const createClient = () => globalThis.__homeStatsDb.publicClient; export const createServiceClient = () => globalThis.__homeStatsDb.serviceClient;`,
    '@/lib/localizedContent': `export const localizedValue = (row, key) => row?.[key] ?? ''; export const safeContentLocale = (value) => value || 'ru';`,
    '@/lib/siteFooter': `export const footerFromContent = () => null;`,
  },
});

const statisticKeys = ['home.statsCmdrs', 'home.statsSystems', 'home.statsBuilt'];

test('homepage headline statistics are translated in every supported site language', () => {
  for (const locale of translations.SUPPORTED_LOCALES) {
    for (const key of statisticKeys) {
      const value = translations.translations[locale]?.[key];
      assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
      assert.ok(value.trim(), `${locale} has an empty ${key}`);
    }
  }
  assert.match(translations.translations.ru['home.statsCmdrs'], /зарегистр/i);
  assert.match(translations.translations.ru['home.statsSystems'], /маршрут/i);
  assert.match(translations.translations.ru['home.statsBuilt'], /командир/i);
});

function fakeClient(role, calls) {
  return {
    from(table) {
      const call = { role, table, filters: [], options: null };
      calls.push(call);
      let query = {
        select(columns, options) { call.columns = columns; call.options = options; return query; },
        eq(...args) { call.filters.push(['eq', ...args]); return query; },
        or(...args) { call.filters.push(['or', ...args]); return query; },
        gte(...args) { call.filters.push(['gte', ...args]); return query; },
        not(...args) { call.filters.push(['not', ...args]); return query; },
        order() { return query; },
        limit() { return query; },
        maybeSingle() { return Promise.resolve({ data: { id: 1 }, error: null }); },
        then(resolve, reject) {
          const result = table === 'public_profiles' ? { count: 17, data: null, error: null }
            : table === 'route_systems' ? { count: 6, data: null, error: null }
              : table === 'colonisation_sites' ? { count: 9, data: null, error: null }
                : { count: null, data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test('homepage counts registered cmdrs, completed project-route systems, and commanders completed facilities', async () => {
  const calls = [];
  globalThis.__homeStatsDb = {
    publicClient: fakeClient('public', calls),
    serviceClient: fakeClient('service', calls),
  };
  try {
    const response = await api.GET(new Request('https://example.test/api/home-data?locale=ru'));
    assert.equal(response.body.cmdrs, 17);
    assert.equal(response.body.systems, 6);
    assert.equal(response.body.built, 9);

    assert.ok(calls.some((call) => call.table === 'public_profiles' && call.options?.head));
    const route = calls.find((call) => call.table === 'route_systems');
    assert.ok(route, 'systems statistic must read project route_systems, not hubs');
    assert.ok(route.filters.some(([kind, filter]) => kind === 'or' && filter === 'status.eq.done,progress.gte.100'));

    const facilities = calls.find((call) => call.table === 'colonisation_sites');
    assert.ok(facilities && facilities.role === 'service', 'private journal sites must be read with service role');
    assert.ok(facilities.filters.some(([kind, key, value]) => kind === 'gte' && key === 'construction_progress' && value === 100));
    assert.ok(facilities.filters.some(([kind, key, operator, value]) => kind === 'not' && key === 'user_id' && operator === 'is' && value === null));
    assert.equal(calls.some((call) => call.table === 'hubs'), false, 'hub count is not a project-route system or completed facility count');
  } finally {
    delete globalThis.__homeStatsDb;
  }
});
