import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCapiNetwork } from '../../src/lib/capi/networkProbe.ts';

test('server-side CAPI network probe considers unauthenticated Frontier response reachable and sends no token', async () => {
  const requests = [];
  const result = await probeCapiNetwork({
    lookup: async () => [{ address: '192.0.2.10', family: 4 }],
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 401 });
    },
  });

  assert.equal(result.probes.length, 2);
  assert.ok(result.probes.every((probe) => probe.reachable && probe.https.ok && probe.https.status === 401));
  assert.deepEqual(new Set(requests.map((request) => new URL(request.url).hostname)), new Set([
    'companion.orerve.net',
    'legacy-companion.orerve.net',
  ]));
  assert.ok(requests.every(({ init }) => init.method === 'GET' && !('Authorization' in init.headers)));
});

test('server-side CAPI network probe reports DNS failures independently per host', async () => {
  const result = await probeCapiNetwork({
    lookup: async (hostname) => {
      if (hostname === 'companion.orerve.net') {
        const error = new Error('temporary lookup failure');
        error.code = 'EAI_AGAIN';
        throw error;
      }
      return [{ address: '192.0.2.20', family: 4 }];
    },
    fetch: async () => new Response(null, { status: 403 }),
  });

  const live = result.probes.find((probe) => probe.host === 'companion.orerve.net');
  const legacy = result.probes.find((probe) => probe.host === 'legacy-companion.orerve.net');
  assert.equal(live.dns.ok, false);
  assert.equal(live.dns.code, 'EAI_AGAIN');
  assert.equal(live.https.ok, false);
  assert.equal(legacy.reachable, true);
  assert.equal(legacy.https.status, 403);
});

test('server-side CAPI network probe reports HTTPS egress failure after successful DNS', async () => {
  const result = await probeCapiNetwork({
    lookup: async () => [{ address: '192.0.2.10', family: 4 }],
    fetch: async () => {
      const error = new Error('fetch failed');
      error.cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      throw error;
    },
  });

  assert.ok(result.probes.every((probe) => probe.dns.ok && !probe.reachable));
  assert.ok(result.probes.every((probe) => probe.https.code === 'UND_ERR_CONNECT_TIMEOUT'));
});
