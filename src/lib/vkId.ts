import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { getSiteUrl } from './siteUrl.ts';
import { isOAuthProvider, type OAuthMode } from './oauthProviders.ts';

export { VK_PROVIDER, VK_LABEL, vkErrorMessage } from './vkShared.ts';

/**
 * VK ID (OAuth 2.1, id.vk.com). Self-hosted GoTrue has no VK provider and
 * VK ID deviates from plain OAuth (mandatory PKCE, `device_id` in the token
 * request, POST-only user_info), so the flow lives here, on the site server:
 *   /login → startVkAuthAction → id.vk.com/authorize → /api/auth/vk/callback
 * Identity ↔ account mapping is the `vk_identities` table (service role only).
 */
export const VK_AUTHORIZE_URL = 'https://id.vk.com/authorize';
export const VK_TOKEN_URL = 'https://id.vk.com/oauth2/auth';
export const VK_USER_INFO_URL = 'https://id.vk.com/oauth2/user_info';
export const VK_LOGOUT_URL = 'https://id.vk.com/oauth2/logout';
export const VK_FLOW_COOKIE = 'edrc-vk-flow';
export const VK_FLOW_TTL = 10 * 60;
export const VK_SCOPES = 'email';

export type VkFlow = {
  mode: OAuthMode;
  userId: string | null;
  state: string;
  verifier: string;
  expiresAt: number;
};

export type VkUserInfo = {
  user_id: string;
  first_name?: string;
  last_name?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  is_verified?: boolean;
};

export function vkConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = (env.VK_ID_CLIENT_ID ?? '').trim();
  const clientSecret = (env.VK_ID_CLIENT_SECRET ?? '').trim();
  return { clientId, clientSecret, enabled: /^\d+$/.test(clientId) };
}
export function vkEnabled(env: NodeJS.ProcessEnv = process.env) { return vkConfig(env).enabled; }
export function vkRedirectUri(origin = getSiteUrl()) { return `${origin}/api/auth/vk/callback`; }

function signingKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  return key;
}
function signature(payload: string, key: string) {
  return createHmac('sha256', key).update(`edrc-vk-flow:v1:${payload}`).digest('base64url');
}
export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Signed, short-lived browser cookie holding PKCE verifier + CSRF state + intent. */
export function createVkFlow(mode: OAuthMode, userId: string | null, now = Date.now(), key = signingKey()) {
  if (mode === 'link' && !userId) throw new Error('not_authenticated');
  const flow: VkFlow = { mode, userId, state: randomBytes(16).toString('hex'),
    verifier: randomBytes(32).toString('base64url'), expiresAt: now + VK_FLOW_TTL * 1000 };
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return { flow, cookie: `${payload}.${signature(payload, key)}` };
}

export function readVkFlow(value: string | undefined, now = Date.now(), key?: string): VkFlow | null {
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

export function vkAuthorizeUrl(flow: Pick<VkFlow, 'state' | 'verifier'>, clientId: string, origin = getSiteUrl()) {
  const url = new URL(VK_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', vkRedirectUri(origin));
  url.searchParams.set('state', flow.state);
  url.searchParams.set('code_challenge', pkceChallenge(flow.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', VK_SCOPES);
  return url.toString();
}

export class VkAuthError extends Error {
  code: string;
  constructor(code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

async function postForm(fetchImpl: typeof fetch, url: string, body: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!json || typeof json !== 'object') throw new VkAuthError('vk_unavailable', `HTTP ${response.status}`);
    if (!response.ok || json.error) {
      // Never surface error_description (may echo tokens/emails); keep bounded codes.
      const code = String(json.error || response.status);
      throw new VkAuthError(/invalid_grant|invalid_request|expired/.test(code) ? 'expired' : 'vk_failed', code);
    }
    return json;
  } finally { clearTimeout(timer); }
}

/** Exchanges the redirect `code` + `device_id` for tokens using the PKCE verifier. */
export async function exchangeVkCode(params: { code: string; deviceId: string; state: string; flow: VkFlow;
  clientId: string; clientSecret?: string; origin?: string; fetchImpl?: typeof fetch }) {
  const body: Record<string, string> = {
    grant_type: 'authorization_code', code: params.code, code_verifier: params.flow.verifier,
    client_id: params.clientId, device_id: params.deviceId, redirect_uri: vkRedirectUri(params.origin),
    state: params.state,
  };
  if (params.clientSecret) body.client_secret = params.clientSecret;
  const json = await postForm(params.fetchImpl ?? fetch, VK_TOKEN_URL, body);
  if (typeof json.access_token !== 'string' || !json.access_token) throw new VkAuthError('vk_failed', 'no access_token');
  if (json.state && json.state !== params.state) throw new VkAuthError('state_mismatch');
  return { accessToken: json.access_token as string, userId: json.user_id != null ? String(json.user_id) : null };
}

export async function fetchVkUserInfo(accessToken: string, clientId: string, fetchImpl: typeof fetch = fetch): Promise<VkUserInfo> {
  const json = await postForm(fetchImpl, VK_USER_INFO_URL, { access_token: accessToken, client_id: clientId });
  const user = json.user;
  if (!user || typeof user !== 'object' || user.user_id == null || !/^\d+$/.test(String(user.user_id))) {
    throw new VkAuthError('vk_failed', 'no user');
  }
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
  const email = text(user.email, 254)?.toLowerCase();
  return {
    user_id: String(user.user_id),
    first_name: text(user.first_name, 100), last_name: text(user.last_name, 100),
    avatar: text(user.avatar, 2000)?.startsWith('https://') ? text(user.avatar, 2000) : undefined,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined,
    is_verified: Boolean(user.is_verified),
  };
}

/** VK accounts often expose no email; GoTrue still needs one. No mail is ever sent there. */
export function vkPlaceholderEmail(vkUserId: string, origin = getSiteUrl()) {
  return `vk-${vkUserId}@vk.${new URL(origin).hostname}`;
}
export function isVkPlaceholderEmail(email: string | null | undefined, origin = getSiteUrl()) {
  return Boolean(email && new RegExp(`^vk-\\d+@vk\\.${new URL(origin).hostname.replace(/\./g, '\\.')}$`, 'i').test(email));
}
export function vkDisplayName(info: Pick<VkUserInfo, 'first_name' | 'last_name'>) {
  return [info.first_name, info.last_name].filter(Boolean).join(' ').trim() || undefined;
}

/** A VK link may be removed only if some other *usable* way to sign in remains. */
export function canUnlinkVk(user: Pick<User, 'identities' | 'email' | 'email_confirmed_at'>, enabled: readonly string[], origin = getSiteUrl()) {
  return Boolean(user.identities?.some(identity =>
    identity.provider === 'email'
      ? Boolean(user.email_confirmed_at) && !isVkPlaceholderEmail(user.email, origin)
      : isOAuthProvider(identity.provider) && enabled.includes(identity.provider)));
}
