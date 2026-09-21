import { getBillingAdapter } from '../billing/storage.ts';
import { AUTH_PROVIDER_REGISTRY, DEFAULT_VISIBLE, authProviderMeta,
  type AuthProviderSetting, type AuthProviderSettings } from './registry.ts';

/** Stored as one JSON row in `billing_settings` (service role only, RLS on). */
const ROW_ID = 'auth_providers';

function normalize(raw: any): AuthProviderSettings {
  const out: AuthProviderSettings = {};
  for (const meta of AUTH_PROVIDER_REGISTRY) {
    const v = raw?.[meta.id] ?? {};
    out[meta.id] = {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : Boolean(DEFAULT_VISIBLE[meta.id]),
      client_id: typeof v.client_id === 'string' ? v.client_id.slice(0, 200) : '',
      client_secret: typeof v.client_secret === 'string' && v.client_secret ? v.client_secret.slice(0, 500) : undefined,
      notes: typeof v.notes === 'string' ? v.notes.slice(0, 1000) : '',
      updated_at: typeof v.updated_at === 'string' ? v.updated_at : undefined,
    };
  }
  return out;
}

export async function getAuthProviderSettings(): Promise<AuthProviderSettings> {
  try {
    const a = await getBillingAdapter();
    const row = await a.get<{ id: string; value: any }>('billing_settings', ROW_ID);
    return normalize(row?.value);
  } catch {
    return normalize({});
  }
}

export type AuthProviderPatch = Partial<Record<string, Partial<AuthProviderSetting> & { clear_secret?: boolean }>>;

export async function updateAuthProviderSettings(patch: AuthProviderPatch): Promise<AuthProviderSettings> {
  const a = await getBillingAdapter();
  const current = await getAuthProviderSettings();
  const now = new Date().toISOString();
  for (const [id, change] of Object.entries(patch)) {
    if (!authProviderMeta(id) || !change || typeof change !== 'object') continue;
    const cur = current[id];
    const next: AuthProviderSetting = { ...cur, updated_at: now };
    if (typeof change.enabled === 'boolean') next.enabled = change.enabled;
    if (typeof change.client_id === 'string') next.client_id = change.client_id.trim().slice(0, 200);
    if (typeof change.notes === 'string') next.notes = change.notes.slice(0, 1000);
    if (change.clear_secret) next.client_secret = undefined;
    else if (typeof change.client_secret === 'string' && change.client_secret.trim()) next.client_secret = change.client_secret.trim().slice(0, 500);
    current[id] = next;
  }
  await a.upsert('billing_settings', { id: ROW_ID, value: current, updated_at: now });
  return current;
}

/** Browser-safe projection: secrets replaced by a boolean. */
export function publicAuthProviderSettings(settings: AuthProviderSettings) {
  return Object.fromEntries(Object.entries(settings).map(([id, v]) => [id, {
    enabled: v.enabled, client_id: v.client_id, notes: v.notes, updated_at: v.updated_at ?? null, has_secret: Boolean(v.client_secret),
  }]));
}

/** VK ID: admin toggle AND a client id (admin panel first, env second). */
export async function resolveVkSettings(env: NodeJS.ProcessEnv = process.env) {
  const settings = await getAuthProviderSettings();
  const vk = settings.vk;
  const clientId = (vk.client_id || env.VK_ID_CLIENT_ID || '').trim();
  const clientSecret = (vk.client_secret || env.VK_ID_CLIENT_SECRET || '').trim();
  return { enabled: vk.enabled && /^\d+$/.test(clientId), clientId, clientSecret, adminEnabled: vk.enabled };
}

/** GoTrue providers shown to visitors = allowed by env ∩ enabled by admin. */
export async function visibleGotrueProviders<T extends string>(envEnabled: readonly T[]): Promise<T[]> {
  const settings = await getAuthProviderSettings();
  return envEnabled.filter(provider => {
    const meta = AUTH_PROVIDER_REGISTRY.find(item => item.gotrue === provider);
    return !meta || settings[meta.id]?.enabled !== false;
  });
}
