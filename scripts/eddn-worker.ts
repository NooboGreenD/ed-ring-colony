// ═══════════════════════════════════════════════════════════════
// EDDN Worker — standalone process for ZeroMQ subscription
// ═══════════════════════════════════════════════════════════════

import { startEddnListener } from '../src/lib/eddn/subscriber';

const INGEST_URL = process.env.EDDN_INGEST_URL || 'https://ed-ring-colony.vercel.app/api/eddn/ingest';
const INGEST_SECRET = process.env.EDDN_INGEST_SECRET || '';

if (!INGEST_SECRET) {
  console.error('[EDDN] EDDN_INGEST_SECRET not set');
  process.exit(1);
}

startEddnListener(INGEST_URL, INGEST_SECRET).catch((err) => {
  console.error('[EDDN] Fatal error:', err);
  process.exit(1);
});
