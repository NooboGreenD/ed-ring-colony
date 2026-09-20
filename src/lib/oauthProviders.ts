import type { User } from "@supabase/supabase-js";

export const OAUTH_PROVIDERS = {
  discord: { label: 'Discord', scopes: 'identify email' },
  google: { label: 'Google', scopes: 'email profile' },
  github: { label: 'GitHub', scopes: 'read:user user:email' },
} as const;
export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;
export type OAuthMode = 'login' | 'link';

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, value);
}

/** Runtime, server-only configuration; enabling a button does not configure GoTrue. */
export function enabledOAuthProviders(value = process.env.AUTH_OAUTH_PROVIDERS ?? 'discord'): OAuthProvider[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(isOAuthProvider))];
}

export function oauthErrorMessage(raw: string, provider?: OAuthProvider): string {
  const message = raw.toLowerCase();
  const label = provider ? OAUTH_PROVIDERS[provider].label : 'Провайдер';
  if (/manual linking|linking identities|manual_linking_disabled/.test(message)) {
    return 'Привязка отключена на сервере Supabase. Включите GOTRUE_SECURITY_MANUAL_LINKING_ENABLED в сервисе auth и пересоздайте контейнер.';
  }
  if (/already been registered|already exists|identity.*already|identity_already_exists/.test(message)) {
    return `${label} уже привязан к аккаунту. Если это другое досье, сначала войдите в него: автоматического объединения профилей нет.`;
  }
  if (/unsupported provider|provider is not enabled|provider_disabled/.test(message)) {
    return `${label} не включён в сервисе Supabase Auth. Проверьте GOTRUE_EXTERNAL_* и настройки OAuth-приложения.`;
  }
  if (/redirect/.test(message)) {
    return 'Проверьте адреса возврата: https://supabase.edringcolony.ru/auth/v1/callback у провайдера и https://edringcolony.ru/api/auth/callback в Supabase.';
  }
  if (/access_denied|cancelled|denied/.test(message)) return 'Авторизация отменена. Аккаунт не изменён.';
  if (/expired|no_code|flow_state|code verifier|pkce|invalid_grant/.test(message)) {
    return 'Срок авторизации истёк или отсутствует PKCE-cookie. Начните заново в той же вкладке браузера.';
  }
  if (/not_authenticated|session.*missing/.test(message)) return 'Сначала войдите в аккаунт, к которому нужно привязать способ входа.';
  if (/account_mismatch/.test(message)) return 'Аккаунт во время привязки изменился. Привязка не подтверждена; войдите в исходное досье и повторите.';
  if (/last_identity/.test(message)) return 'Нельзя удалить последний доступный способ входа. Сначала добавьте пароль или другого провайдера.';
  return 'Не удалось завершить авторизацию. Повторите попытку; если ошибка сохраняется, проверьте настройки Supabase Auth.';
}

/** UI safety guard; GoTrue independently enforces ownership and identity count. */
export function canUnlinkOAuthIdentity(user: Pick<User, 'identities' | 'email_confirmed_at'>,
  provider: OAuthProvider, enabled: readonly OAuthProvider[]): boolean {
  const identity = user.identities?.find(item => item.provider === provider);
  if (!identity) return false;
  // identity_id is the unique GoTrue identity UUID. `id` is the provider's
  // subject and can coincide between two different OAuth providers.
  return Boolean(user.identities?.some(item => item.identity_id !== identity.identity_id && (
    item.provider === 'email' ? Boolean(user.email_confirmed_at) :
      isOAuthProvider(item.provider) && enabled.includes(item.provider)
  )));
}
