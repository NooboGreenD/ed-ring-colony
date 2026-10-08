import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nginxConfigs = [
  'deploy/nginx.conf',
  'deploy/selfhost/nginx-selfhost.conf',
  'deploy/selfhost/install.sh',
];

test('ColonialHelper release endpoint has a 200 MiB limit in every project nginx template', () => {
  for (const file of nginxConfigs) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const location = source.match(/location\s*=\s*\/api\/admin\/uploader\/release\s*\{([^}]*)\}/s)?.[1];
    assert.ok(location, `${file} contains the release-upload location`);
    assert.match(location, /client_max_body_size\s+200m\s*;/, `${file} allows a 200 MiB request`);
  }
});
