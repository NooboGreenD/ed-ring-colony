// ═══════════════════════════════════════════════════════════════
// Frontier CAPI OAuth 2.0 Flow
// ═══════════════════════════════════════════════════════════════

const FRONTIER_AUTH_URL = 'https://auth.frontierstore.net/auth';
const FRONTIER_TOKEN_URL = 'https://auth.frontierstore.net/token';

export function buildAuthUrl(state: string): string {
  const clientId = process.env.FRONTIER_CLIENT_ID;
  const redirectUri = process.env.FRONTIER_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('FRONTIER_CLIENT_ID or FRONTIER_REDIRECT_URI not configured');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'auth capi',
    state,
  });

  return `${FRONTIER_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}> {
  const clientId = process.env.FRONTIER_CLIENT_ID;
  const clientSecret = process.env.FRONTIER_CLIENT_SECRET;
  const redirectUri = process.env.FRONTIER_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Frontier OAuth credentials not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch(FRONTIER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Frontier token error: ${res.status} ${errText}`);
  }

  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const clientId = process.env.FRONTIER_CLIENT_ID;
  const clientSecret = process.env.FRONTIER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Frontier OAuth credentials not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(FRONTIER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Frontier refresh error: ${res.status} ${errText}`);
  }

  return res.json();
}
