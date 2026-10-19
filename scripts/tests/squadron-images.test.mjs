import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://public.test';
const stubs = {
  'next/server': `export class NextResponse extends Response { static json(value, init) { return Response.json(value, init); } }`,
  '@/lib/supabaseServer': `export const createServiceClient=()=>globalThis.images.client; export const authFromRequest=async()=>({ user: globalThis.images.user, supabase:globalThis.images.client });`,
  '@/lib/squadronData': `export const getSquadronMembership=async()=>globalThis.images.membership;`,
  '@/lib/supabaseUrl': `export const getPublicSupabaseUrl=()=> 'https://public.test';`,
};
const branding = await import(await bundleFile({ entry: 'src/app/api/squadrons/[id]/branding/route.ts', stubs }));
const images = await import(await bundleFile({ entry: 'src/app/api/squadrons/[id]/images/[kind]/route.ts', stubs }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const context = (kind = 'logo') => ({ params: Promise.resolve({ id: '42', kind }) });
function setup(mode = 'ok') {
  const state = { user: { id: 'owner' }, membership: null, mode, uploads: [], created: [], rows: [],
    squadron: { id: 42, created_by: 'owner', logo_url: '/old.png', banner_url: null }, dbError: null };
  state.client = {
    storage: {
      from: () => ({ upload: async (...args) => {
        state.uploads.push(args);
        if (state.mode === 'throw') throw new TypeError('fetch failed');
        return { error: state.mode === 'ok' ? null : { message: state.mode === 'missing' ? 'Bucket not found' : 'Service Unavailable', statusCode: state.mode === 'missing' ? 404 : 503 } };
      } }),
      createBucket: async (name, options) => { state.created.push({ name, options }); state.mode = 'ok'; return { error: null }; },
    },
    from(table) {
      let op = 'read', values, filters = [];
      const run = () => {
        if (state.dbError && table === 'squadron_images') return { error: state.dbError };
        const matching = row => filters.every(([key, value]) => row[key] === value);
        if (table === 'squadrons') {
          if (op === 'update') Object.assign(state.squadron, values);
          return { data: state.squadron, error: null };
        }
        if (op === 'upsert') {
          const i = state.rows.findIndex(row => row.squadron_id === values.squadron_id && row.kind === values.kind);
          if (i < 0) state.rows.push(values); else state.rows[i] = values;
        }
        if (op === 'delete') state.rows = state.rows.filter(row => !matching(row));
        return { data: state.rows.find(matching) ?? null, error: null };
      };
      const q = { select: () => q, eq: (k,v) => { filters.push([k,v]); return q; },
        update: v => { op = 'update'; values = v; return q; }, upsert: v => { op = 'upsert'; values = v; return q; },
        delete: () => { op = 'delete'; return q; }, maybeSingle: async () => run(), single: async () => run(),
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject) };
      return q;
    },
  };
  globalThis.images = state;
  return state;
}
function upload(kind = 'logo', bytes = png, type = 'image/png') {
  const form = new FormData(); form.set('kind', kind); form.set('file', new File([bytes], 'photo.png', { type }));
  return new Request('https://site.test/api/squadrons/42/branding', { method: 'POST', body: form });
}
const getImage = (url, kind, headers) => images.GET(new Request('https://site.test' + url, { headers }), context(kind));
test.afterEach(() => { delete globalThis.images; });

test('working Storage returns public URL; missing bucket is created with 6 MiB cap', async () => {
  for (const mode of ['ok', 'missing']) {
    const state = setup(mode);
    const response = await branding.POST(upload(), context());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.storage, 'storage');
    assert.match(body.url, /^https:\/\/public.test\/storage\/v1\/object\/public\/squadron-media\/42\/logo-/);
    assert.equal(state.rows.length, 0);
    if (mode === 'missing') assert.equal(state.created[0].options.fileSizeLimit, 6 * 1024 * 1024);
  }
});

test('503 or network error saves both kinds; public GET returns same bytes and ETag', async () => {
  for (const mode of ['unavailable', 'throw']) {
    const state = setup(mode);
    for (const kind of ['logo', 'banner']) {
      const response = await branding.POST(upload(kind), context());
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.storage, 'database');
      assert.match(body.warning, /сохранено в базе/);
      assert.equal(state.squadron[`${kind}_url`], body.url);
      const file = await getImage(body.url, kind);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'image/png');
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
      assert.equal((await getImage(body.url, kind, { 'if-none-match': file.headers.get('etag') })).status, 304);
    }
    assert.equal(state.rows.length, 2);
  }
});

test('authorization denies guests and ordinary members, permits delegated editor', async () => {
  const state = setup('unavailable');
  state.user = null;
  assert.equal((await branding.POST(upload(), context())).status, 401);
  state.user = { id: 'member' };
  state.membership = { can_edit_squadron: false };
  assert.equal((await branding.POST(upload(), context())).status, 403);
  const del = new Request('https://site.test/api/squadrons/42/branding?kind=logo', { method: 'DELETE' });
  assert.equal((await branding.DELETE(del, context())).status, 403);
  assert.equal(state.uploads.length, 0);
  state.membership.can_edit_squadron = true;
  assert.equal((await branding.POST(upload(), context())).status, 200);
});

test('size/type/kind validation happens before upload and database writes', async () => {
  const state = setup();
  for (const [kind, bytes, mime, status] of [
    ['logo', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png', 413],
    ['banner', Buffer.alloc(6 * 1024 * 1024 + 1), 'image/png', 413],
    ['logo', png, 'image/svg+xml', 415], ['logo', Buffer.alloc(0), 'image/png', 400],
    ['unknown', png, 'image/png', 400],
  ]) assert.equal((await branding.POST(upload(kind, bytes, mime), context())).status, status);
  assert.equal(state.uploads.length, 0);
  assert.equal(state.rows.length, 0);
});

test('fallback failure is actionable and preserves current squadron URL', async () => {
  const state = setup('unavailable'); state.dbError = { message: 'missing table' };
  const response = await branding.POST(upload(), context());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /миграции/);
  assert.equal(state.squadron.logo_url, '/old.png');
});

test('replacement remains bounded, old version is not cached as new bytes, delete cleans only chosen kind', async () => {
  const state = setup('unavailable');
  const first = await (await branding.POST(upload(), context())).json();
  await branding.POST(upload('banner'), context());
  const second = await (await branding.POST(upload('logo', Buffer.concat([png, Buffer.from('new')])), context())).json();
  assert.equal(state.rows.length, 2);
  assert.notEqual(first.url, second.url);
  assert.equal((await getImage(first.url, 'logo')).status, 404);
  assert.equal((await getImage(second.url, 'logo')).status, 200);
  const unversioned = await getImage('/api/squadrons/42/images/logo', 'logo');
  assert.match(unversioned.headers.get('cache-control'), /must-revalidate/);
  const response = await branding.DELETE(new Request('https://site.test/api/squadrons/42/branding?kind=logo', { method: 'DELETE' }), context());
  assert.equal(response.status, 200);
  assert.equal(state.squadron.logo_url, null);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].kind, 'banner');
  assert.equal((await getImage(second.url, 'logo')).status, 404);
});

test('public image route handles missing image, malformed ids and database outage', async () => {
  const state = setup();
  assert.equal((await getImage('/api/squadrons/42/images/logo', 'logo')).status, 404);
  assert.equal((await getImage('/api/squadrons/42/images/bad', 'bad')).status, 404);
  state.dbError = { message: 'database unavailable' };
  const response = await getImage('/api/squadrons/42/images/logo', 'logo');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
