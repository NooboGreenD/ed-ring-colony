import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Retired token bridge.
 *
 * Frontier OAuth and refresh tokens are owned exclusively by the website. The
 * previous GET/POST bridge copied refresh-token pairs into Colonial Helper and
 * allowed the Helper to create a website binding independently, which made the
 * two clients race over Frontier's rotating refresh token. Helper now uses the
 * project API token with `/api/capi/helper`; the website performs and stores
 * every CAPI request itself. Keep this route as an explicit response so older
 * Helper builds fail safely rather than silently starting a second binding.
 */
function retired() {
  return NextResponse.json({
    error: 'Этот обмен токенами отключён. Подключите Frontier на сайте; Colonial Helper использует /api/capi/helper.',
    code: 'capi_token_bridge_retired',
  }, { status: 410, headers: HEADERS });
}

export async function GET() {
  return retired();
}

export async function POST() {
  return retired();
}
