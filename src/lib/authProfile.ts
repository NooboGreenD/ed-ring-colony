export function nickFromUser(
  user: {
    email?: string | null;
    user_metadata?: Record<string, unknown> | null;
  } | null,
  profile?: { cmdr_name?: string | null } | null,
) {
  const meta = user?.user_metadata ?? {};
  return (
    profile?.cmdr_name ||
    (typeof meta.cmdr_name === 'string' && meta.cmdr_name) ||
    (typeof meta.custom_claims === 'object' &&
      meta.custom_claims &&
      typeof (meta.custom_claims as { global_name?: string }).global_name === 'string' &&
      (meta.custom_claims as { global_name: string }).global_name) ||
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    (typeof meta.preferred_username === 'string' && meta.preferred_username) ||
    user?.email?.split('@')[0] ||
    'Пилот'
  );
}

export function avatarFromUser(
  user: { user_metadata?: Record<string, unknown> | null } | null,
  profile?: { avatar_url?: string | null } | null,
) {
  if (profile?.avatar_url) return profile.avatar_url;
  const meta = user?.user_metadata ?? {};
  if (typeof meta.avatar_url === 'string' && meta.avatar_url) return meta.avatar_url;
  if (typeof meta.picture === 'string' && meta.picture) return meta.picture;
  return null;
}

export function hasProvider(
  user: {
    identities?: { provider?: string }[] | null;
    app_metadata?: { providers?: string[] } | null;
  } | null,
  provider: string,
) {
  if ((user?.identities ?? []).some((i) => i.provider === provider)) return true;
  const providers = user?.app_metadata?.providers;
  return Array.isArray(providers) && providers.includes(provider);
}
