// ═══════════════════════════════════════════════════════════════
// EDDN ZeroMQ Subscriber (standalone Node.js process)
// Run: npx ts-node scripts/eddn-worker.ts
// ═══════════════════════════════════════════════════════════════

import { inflateSync } from 'node:zlib';

const EDDN_RELAY = 'tcp://eddn.edcd.io:9500';

export async function startEddnListener(
  ingestUrl: string,
  secret: string
): Promise<void> {
  let zmq: any;
  try {
    zmq = await import('zeromq');
  } catch {
    console.error('[EDDN] zeromq not installed. Run: npm install zeromq');
    process.exit(1);
  }

  const sock = new zmq.Subscriber();
  sock.connect(EDDN_RELAY);
  sock.subscribe('');

  console.log('[EDDN] Connected to', EDDN_RELAY);

  for await (const [msg] of sock) {
    try {
      const data = JSON.parse(inflateSync(msg).toString('utf-8'));
      if (!/\/(commodity|outfitting|shipyard)\//.test(data.$schemaRef || '') || data.$schemaRef.includes('/test')) continue;

      const res = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EDDN-Secret': secret,
        },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        console.error('[EDDN] Ingest failed:', res.status);
      }
    } catch (err) {
      console.error('[EDDN] Parse error:', err);
    }
  }
}
