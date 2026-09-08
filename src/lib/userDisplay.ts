export type AuthUser = {
  email?: string | null;
  user_metadata?: Record<string, any>;
} | null;

export type ProfileRow = {
  cmdr_name?: string | null;
  avatar_url?: string | null;
} | null;

export function nicknameFrom(user: AuthUser, profile: ProfileRow) {
  return (
    profile?.cmdr_name ||
    user?.user_metadata?.cmdr_name ||
    user?.user_metadata?.full_name ||
    user?.user_metadata?.custom_claims?.global_name ||
    user?.user_metadata?.name ||
    user?.user_metadata?.preferred_username ||
    (user?.email ? user.email.split('@')[0] : 'CMDR')
  );
}

export function avatarFrom(user: AuthUser, profile: ProfileRow) {
  return (
    profile?.avatar_url ||
    user?.user_metadata?.avatar_url ||
    user?.user_metadata?.picture ||
    null
  );
}
