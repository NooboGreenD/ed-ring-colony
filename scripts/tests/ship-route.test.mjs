import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('ship route has a separate range cap; colony routing remains limited to 14.99 ly', () => {
  const api = read('src/app/api/atlas/route-finder/route.ts');
  assert.match(api, /routeMode === 'ship'[\s\S]*?Math\.min\(100/);
  assert.match(api, /Math\.min\(14\.99[\s\S]*?routeMode/);
  assert.match(api, /routeMode === 'ship'[\s\S]*?расчётные точки/);
});

test('live loadout and route inbox are private and use separate owner-bound APIs', () => {
  const migration = read('supabase/migrations/20261103090000_ship_route_planner.sql');
  const shipStateApi = read('src/app/api/cmdr/ship-state/route.ts');
  const routeApi = read('src/app/api/cmdr/route/route.ts');
  assert.match(migration, /pilot_ship_state/);
  assert.match(migration, /helper_route_inbox/);
  assert.match(migration, /enable row level security/gi);
  assert.match(migration, /revoke all[\s\S]*?anon, authenticated/gi);
  assert.match(shipStateApi, /authFromRequest/);
  assert.match(shipStateApi, /tokenHash/);
  assert.match(shipStateApi, /Modules\.length > 256/);
  assert.match(routeApi, /action === 'poll'/);
  assert.match(routeApi, /authFromRequest/);
});

test('Atlas ship route calculates from journal Loadout and exposes explicit Helper transfer', () => {
  const finder = read('src/components/Atlas/AtlasShipRouteFinder.tsx');
  const routeFinder = read('src/components/Atlas/AtlasRouteFinder.tsx');
  const helper = read('uploader/colonial_helper.py');
  const client = read('uploader/api_client.py');
  assert.match(finder, /fromSlef/);
  assert.match(finder, /computeStats/);
  assert.match(finder, /profileAt/);
  assert.match(routeFinder, /Передать в Helper/);
  assert.match(helper, /_maybe_sync_ship_state/);
  assert.match(helper, /Забрать из Atlas/);
  assert.match(client, /upload_ship_state/);
  assert.match(client, /pull_atlas_route/);
});
