import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { getSiteUrl } from './siteUrl.ts';
import { isOAuthProvider, type OAuthMode } from './oauthProviders.ts';

export { YANDEX_PROVIDER, YANDEX_LABEL, yandexErrorMessage } from './yandexShared.ts';

/**
 * Яндекс ID (oauth.yandex.ru). Self-hosted GoTrue has no Yandex provider, so
 * the flow lives here, on the site server (mirroring the VK ID flow):
 *   /login → startYandexAuthAction → oauth.yandex.ru/authorize → /api/auth/yandex/callback
 * Identity ↔ account mapping is the `yandex_identities` table (service role only).
 * Differences from VK: classic code exchange (no device_id), client_secret is
 * required for Web apps, user info is a GET with an `OAuth` bearer header.
 */
export const YANDEX_AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
export const YANDEX_TOKEN_URL = 'https://oauth.yandex.ru/token';
export const YANDEX_USER_INFO_URL = 'https://login.yandex.ru/info';
export const YANDEX_AVATAR_URL = 'https://avatars.yandex.net/get-yapic';
export const YANDEX_FLOW_COOKIE = 'edrc-yandex-flow';
export const YANDEX_FLOW_TTL = 10 * 60;
export const YANDEX_SCOPES = 'login:email login:info login:avatar';

/** Yandex issues exactly 32 hex characters; guards against pasted garbage. */
export const YANDEX_CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

export type YandexFlow = {
  mode: OAuthMode;
  userId: string | null;
  state: string;
  verifier: string;
  expiresAt: number;
};

export type YandexUserInfo = {
  user_id: string;
  login?: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  avatar?: string;
  email?: string;
};

export function yandexConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = (env.YANDEX_ID_CLIENT_ID ?? '').trim();
  const clientSecret = (env.YANDEX_ID_CLIENT_SECRET ?? '').trim();
  return { clientId, clientSecret, enabled: YANDEX_CLIENT_ID_RE.test(clientId) };
}
export function yandexEnabled(env: NodeJS.ProcessEnv = process.env) { return yandexConfig(env).enabled; }
export function yandexRedirectUri(origin = getSiteUrl()) { return `${origin}/api/auth/yandex/callback`; }

function signingKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  return key;
}
function signature(payload: string, key: string) {
  return createHmac('sha256', key).update(`edrc-yandex-flow:v1:${payload}`).digest('base64url');
}
export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Signed, short-lived browser cookie holding PKCE verifier + CSRF state + intent. */
export function createYandexFlow(mode: OAuthMode, userId: string | null, now = Date.now(), key = signingKey()) {
  if (mode === 'link' && !userId) throw new Error('not_authenticated');
  const flow: YandexFlow = { mode, userId, state: randomBytes(16).toString('hex'),
    verifier: randomBytes(32).toString('base64url'), expiresAt: now + YANDEX_FLOW_TTL * 1000 };
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return { flow, cookie: `${payload}.${signature(payload, key)}` };
}

export function readYandexFlow(value: string | undefined, now = Date.now(), key?: string): YandexFlow | null {
  if (!value || value.length > 2000) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  const expected = Buffer.from(signature(payload, key ?? signingKey()));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!['login', 'link'].includes(flow.mode) || typeof flow.state !== 'string' || typeof flow.verifier !== 'string' ||
        !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now ||
        (flow.mode === 'link' && typeof flow.userId !== 'string')) return null;
    return flow;
  } catch { return null; }
}

export function yandexAuthorizeUrl(flow: Pick<YandexFlow, 'state' | 'verifier'>, clientId: string, origin = getSiteUrl()) {
  const url = new URL(YANDEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', yandexRedirectUri(origin));
  url.searchParams.set('state', flow.state);
  url.searchParams.set('code_challenge', pkceChallenge(flow.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', YANDEX_SCOPES);
  return url.toString();
}

export class YandexAuthError extends Error {
  code: string;
  constructor(code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!json || typeof json !== 'object') throw new YandexAuthError('yandex_unavailable', `HTTP ${response.status}`);
    if (!response.ok || json.error) {
      // Never surface error_description (may echo secrets); keep bounded codes.
      const code = String(json.error || response.status);
      throw new YandexAuthError(/invalid_grant|invalid_request|expired/.test(code) ? 'expired' : 'yandex_failed', code);
    }
    return json;
  } finally { clearTimeout(timer); }
}

/** Exchanges the redirect `code` for an access token using the PKCE verifier. */
export async function exchangeYandexCode(params: { code: string; flow: YandexFlow;
  clientId: string; clientSecret?: string; fetchImpl?: typeof fetch }) {
  const body: Record<string, string> = {
    grant_type: 'authorization_code', code: params.code, code_verifier: params.flow.verifier,
    client_id: params.clientId,
  };
  if (params.clientSecret) body.client_secret = params.clientSecret;
  const json = await requestJson(params.fetchImpl ?? fetch, YANDEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  if (typeof json.access_token !== 'string' || !json.access_token) throw new YandexAuthError('yandex_failed', 'no access_token');
  return { accessToken: json.access_token as string, userId: json.uid != null ? String(json.uid) : null };
}

export async function fetchYandexUserInfo(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<YandexUserInfo> {
  const url = new URL(YANDEX_USER_INFO_URL);
  url.searchParams.set('format', 'json');
  const json = await requestJson(fetchImpl, url.toString(), {
    method: 'GET',
    headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
  });
  if (json.id == null || !/^\d+$/.test(String(json.id))) throw new YandexAuthError('yandex_failed', 'no user');
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
  const email = text(json.default_email, 254)?.toLowerCase();
  // Avatars are served from a fixed Yandex host; the id itself is not a URL.
  const avatarId = text(json.default_avatar_id, 200);
  const avatar = json.is_avatar_empty === false && avatarId && /^[\w/-]+$/.test(avatarId)
    ? `${YANDEX_AVATAR_URL}/${avatarId}/islands-200` : undefined;
  return {
    user_id: String(json.id),
    login: text(json.login, 100),
    first_name: text(json.first_name, 100), last_name: text(json.last_name, 100),
    display_name: text(json.display_name, 100),
    avatar,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined,
  };
}

/** GoTrue needs an e-mail even if Yandex grants none. No mail is ever sent there. */
export function yandexPlaceholderEmail(yandexUserId: string, origin = getSiteUrl()) {
  return `yandex-${yandexUserId}@ya.${new URL(origin).hostname}`;
}
export function isYandexPlaceholderEmail(email: string | null | undefined, origin = getSiteUrl()) {
  return Boolean(email && new RegExp(`^yandex-\\d+@ya\\.${new URL(origin).hostname.replace(/\./g, '\\.')}$`, 'i').test(email));
}
export function yandexDisplayName(info: Pick<YandexUserInfo, 'first_name' | 'last_name' | 'display_name' | 'login'>) {
  return [info.first_name, info.last_name].filter(Boolean).join(' ').trim() || info.display_name || info.login || undefined;
}

/** A Yandex link may be removed only if some other *usable* way to sign in remains. */
export function canUnlinkYandex(user: Pick<User, 'identities' | 'email' | 'email_confirmed_at'>, enabled: readonly string[], origin = getSiteUrl()) {
  return Boolean(user.identities?.some(identity =>
    identity.provider === 'email'
      ? Boolean(user.email_confirmed_at) && !isYandexPlaceholderEmail(user.email, origin)
      : isOAuthProvider(identity.provider) && enabled.includes(identity.provider)));
}
