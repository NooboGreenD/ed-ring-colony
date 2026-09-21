import type { SupabaseClient, User } from '@supabase/supabase-js';
import { VkAuthError, vkDisplayName, vkPlaceholderEmail, type VkUserInfo } from './vkId.ts';

export type VkIdentityRow = {
  user_id: string; vk_user_id: string; email: string | null;
  display_name: string | null; avatar_url: string | null;
};

/** Service-role only. Never called with a user-scoped client. */
export async function findVkIdentity(admin: SupabaseClient, vkUserId: string): Promise<VkIdentityRow | null> {
  const { data, error } = await admin.from('vk_identities').select('user_id, vk_user_id, email, display_name, avatar_url')
    .eq('vk_user_id', vkUserId).maybeSingle();
  if (error) throw new VkAuthError('db_failed', error.message);
  return (data as VkIdentityRow | null) ?? null;
}

export async function findVkIdentityByUser(admin: SupabaseClient, userId: string): Promise<VkIdentityRow | null> {
  const { data, error } = await admin.from('vk_identities').select('user_id, vk_user_id, email, display_name, avatar_url')
    .eq('user_id', userId).maybeSingle();
  if (error) throw new VkAuthError('db_failed', error.message);
  return (data as VkIdentityRow | null) ?? null;
}

function identityPayload(info: VkUserInfo) {
  return { vk_user_id: info.user_id, email: info.email ?? null, display_name: vkDisplayName(info) ?? null,
    avatar_url: info.avatar ?? null, updated_at: new Date().toISOString() };
}

/**
 * Link VK to an existing, signed-in account. A VK identity belongs to exactly
 * one account and an account has at most one VK: no silent re-assignment.
 */
export async function linkVkIdentity(admin: SupabaseClient, userId: string, info: VkUserInfo) {
  const [byVk, byUser] = await Promise.all([findVkIdentity(admin, info.user_id), findVkIdentityByUser(admin, userId)]);
  if (byVk && byVk.user_id !== userId) throw new VkAuthError('already_linked_other');
  if (byUser && byUser.vk_user_id !== info.user_id) throw new VkAuthError('already_linked');
  const { error } = await admin.from('vk_identities').upsert({ user_id: userId, ...identityPayload(info) }, { onConflict: 'user_id' });
  if (error) throw new VkAuthError(error.code === '23505' ? 'already_linked_other' : 'db_failed', error.message);
}

export async function unlinkVkIdentity(admin: SupabaseClient, userId: string) {
  const { error } = await admin.from('vk_identities').delete().eq('user_id', userId);
  if (error) throw new VkAuthError('db_failed', error.message);
}

async function findUserByEmail(admin: SupabaseClient, email: string): Promise<User | null> {
  // GoTrue admin API has no direct "by email" lookup on older versions; a
  // page scan is acceptable for a self-hosted community site.
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new VkAuthError('db_failed', error.message);
    const hit = data.users.find(user => user.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Sign-in: resolve (or create) the GoTrue account behind a verified VK identity.
 * Returns the account id and email used for the session grant.
 */
export async function resolveVkLogin(admin: SupabaseClient, info: VkUserInfo, origin?: string) {
  const existing = await findVkIdentity(admin, info.user_id);
  if (existing) {
    // Refresh display data only in the mapping table; profiles.cmdr_name is user-owned.
    await admin.from('vk_identities').update(identityPayload(info)).eq('user_id', existing.user_id);
    const { data, error } = await admin.auth.admin.getUserById(existing.user_id);
    if (error || !data.user) throw new VkAuthError('db_failed', error?.message);
    return { user: data.user, created: false };
  }
  if (info.email && await findUserByEmail(admin, info.email)) {
    // Same policy as the OAuth providers: never merge accounts by email automatically.
    throw new VkAuthError('email_exists');
  }
  const email = info.email ?? vkPlaceholderEmail(info.user_id, origin);
  const name = vkDisplayName(info);
  const { data, error } = await admin.auth.admin.createUser({
    email, email_confirm: true,
    user_metadata: { ...(name ? { full_name: name } : {}), ...(info.avatar ? { avatar_url: info.avatar } : {}), vk_user_id: info.user_id },
    app_metadata: { provider: 'vk', providers: ['vk'] },
  });
  if (error || !data.user) throw new VkAuthError(/already|exists|registered/i.test(error?.message ?? '') ? 'email_exists' : 'db_failed', error?.message);
  const { error: linkError } = await admin.from('vk_identities').insert({ user_id: data.user.id, ...identityPayload(info) });
  if (linkError) {
    // Do not leave an orphan account that nobody can sign into.
    await admin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
    throw new VkAuthError(linkError.code === '23505' ? 'already_linked_other' : 'db_failed', linkError.message);
  }
  return { user: data.user, created: true };
}

/**
 * Mint a browser session without a password: admin generateLink(magiclink)
 * yields a one-time token hash that the anon SSR client verifies, writing the
 * regular sb-* cookies. No e-mail is sent anywhere in this process.
 */
export async function sessionTokenHash(admin: SupabaseClient, email: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) throw new VkAuthError('session_failed', error?.message);
  return hash;
}
