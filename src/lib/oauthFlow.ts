import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isOAuthProvider, type OAuthMode, type OAuthProvider } from './oauthProviders.ts';

export const OAUTH_FLOW_COOKIE = 'edrc-oauth-flow';
export const OAUTH_FLOW_TTL = 10 * 60;
export type OAuthFlow = {
  provider: OAuthProvider;
  mode: OAuthMode;
  userId: string | null;
  expiresAt: number;
  nonce: string;
};

function signingKey() {
  // Purpose-separated HMAC; this key never leaves the server or enters the cookie.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  return key;
}
function signature(payload: string, key: string) {
  return createHmac('sha256', key).update(`edrc-oauth-flow:v1:${payload}`).digest('base64url');
}

export function createOAuthFlow(provider: OAuthProvider, mode: OAuthMode, userId: string | null,
  now = Date.now(), key = signingKey()) {
  if (mode === 'link' && !userId) throw new Error('not_authenticated');
  const flow: OAuthFlow = { provider, mode, userId, expiresAt: now + OAUTH_FLOW_TTL * 1000,
    nonce: randomBytes(16).toString('hex') };
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return `${payload}.${signature(payload, key)}`;
}

export function readOAuthFlow(value: string | undefined, now = Date.now(), key?: string): OAuthFlow | null {
  if (!value || value.length > 2000) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  const expected = Buffer.from(signature(payload, key ?? signingKey()));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isOAuthProvider(flow.provider) || !['login', 'link'].includes(flow.mode) ||
        !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now ||
        typeof flow.nonce !== 'string' || (flow.mode === 'link' && typeof flow.userId !== 'string')) return null;
    return flow;
  } catch { return null; }
}
