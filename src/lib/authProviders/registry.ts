/**
 * Catalogue of sign-in services the site knows about. Browser-safe: no secrets.
 *
 * kind:
 *  - builtin — always part of Supabase Auth (e-mail/password, magic link)
 *  - gotrue  — OAuth provider handled by Supabase Auth (configured in GoTrue env,
 *              the site only decides whether to show the button)
 *  - site    — OAuth flow implemented by the site itself (VK ID); client id /
 *              secret may be stored here or in the web env
 *  - planned — known service without an implementation yet; settings are kept
 *              for the future, no button is ever shown
 */
export type AuthProviderKind = 'builtin' | 'gotrue' | 'site' | 'planned';

export type AuthProviderMeta = {
  id: string;
  label: string;
  kind: AuthProviderKind;
  /** GoTrue provider name (for kind=gotrue) — matches AUTH_OAUTH_PROVIDERS entries. */
  gotrue?: string;
  docs?: string;
  /** Where the provider must redirect. */
  redirect: 'gotrue' | 'site-vk' | 'none';
  /** Env variables the admin needs to know about (names only). */
  env: string[];
  note?: string;
};

export const GOTRUE_CALLBACK = '/auth/v1/callback';

export const AUTH_PROVIDER_REGISTRY: AuthProviderMeta[] = [
  { id: 'email', label: 'E-mail + пароль', kind: 'builtin', redirect: 'none',
    env: ['AUTH_EMAIL_ENABLED', 'GOTRUE_SMTP_*', 'DISABLE_SIGNUP'],
    note: 'Регистрация и восстановление требуют настроенного SMTP в GoTrue.' },
  { id: 'magiclink', label: 'Magic link (вход по ссылке из письма)', kind: 'builtin', redirect: 'none',
    env: ['GOTRUE_SMTP_*', 'GOTRUE_MAILER_URLPATHS_*'] },
  { id: 'discord', label: 'Discord', kind: 'gotrue', gotrue: 'discord', redirect: 'gotrue',
    docs: 'https://discord.com/developers/applications', env: ['GOTRUE_EXTERNAL_DISCORD_ENABLED', 'GOTRUE_EXTERNAL_DISCORD_CLIENT_ID', 'GOTRUE_EXTERNAL_DISCORD_SECRET'] },
  { id: 'google', label: 'Google', kind: 'gotrue', gotrue: 'google', redirect: 'gotrue',
    docs: 'https://console.cloud.google.com/apis/credentials', env: ['GOTRUE_EXTERNAL_GOOGLE_ENABLED', 'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', 'GOTRUE_EXTERNAL_GOOGLE_SECRET'] },
  { id: 'github', label: 'GitHub', kind: 'gotrue', gotrue: 'github', redirect: 'gotrue',
    docs: 'https://github.com/settings/developers', env: ['GOTRUE_EXTERNAL_GITHUB_ENABLED', 'GOTRUE_EXTERNAL_GITHUB_CLIENT_ID', 'GOTRUE_EXTERNAL_GITHUB_SECRET'] },
  { id: 'vk', label: 'VK ID', kind: 'site', redirect: 'site-vk',
    docs: 'https://id.vk.com/about/business/go', env: ['VK_ID_CLIENT_ID', 'VK_ID_CLIENT_SECRET'],
    note: 'Собственный OAuth 2.1 / PKCE поток сайта. Кнопка появляется только когда включено здесь И задан Client ID (здесь или в env). См. VK-ID-SETUP.md.' },
  { id: 'yandex', label: 'Яндекс ID', kind: 'planned', redirect: 'none', docs: 'https://oauth.yandex.ru/',
    env: ['YANDEX_ID_CLIENT_ID', 'YANDEX_ID_CLIENT_SECRET'], note: 'Нет в GoTrue; потребует собственного потока по образцу VK ID.' },
  { id: 'telegram', label: 'Telegram Login', kind: 'planned', redirect: 'none', docs: 'https://core.telegram.org/widgets/login',
    env: ['TELEGRAM_BOT_TOKEN'], note: 'Виджет с подписью HMAC от бота; отдельная реализация.' },
  { id: 'steam', label: 'Steam (OpenID)', kind: 'planned', redirect: 'none', docs: 'https://steamcommunity.com/dev',
    env: ['STEAM_WEB_API_KEY'], note: 'OpenID 2.0, без e-mail; полезно для привязки к игровому аккаунту.' },
  { id: 'apple', label: 'Apple', kind: 'gotrue', gotrue: 'apple', redirect: 'gotrue', docs: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    env: ['GOTRUE_EXTERNAL_APPLE_ENABLED', 'GOTRUE_EXTERNAL_APPLE_CLIENT_ID', 'GOTRUE_EXTERNAL_APPLE_SECRET'] },
  { id: 'azure', label: 'Microsoft (Azure / Entra ID)', kind: 'gotrue', gotrue: 'azure', redirect: 'gotrue', docs: 'https://portal.azure.com/',
    env: ['GOTRUE_EXTERNAL_AZURE_ENABLED', 'GOTRUE_EXTERNAL_AZURE_CLIENT_ID', 'GOTRUE_EXTERNAL_AZURE_SECRET'] },
  { id: 'twitch', label: 'Twitch', kind: 'gotrue', gotrue: 'twitch', redirect: 'gotrue', docs: 'https://dev.twitch.tv/console/apps',
    env: ['GOTRUE_EXTERNAL_TWITCH_ENABLED', 'GOTRUE_EXTERNAL_TWITCH_CLIENT_ID', 'GOTRUE_EXTERNAL_TWITCH_SECRET'] },
  { id: 'gitlab', label: 'GitLab', kind: 'gotrue', gotrue: 'gitlab', redirect: 'gotrue', docs: 'https://gitlab.com/-/user_settings/applications',
    env: ['GOTRUE_EXTERNAL_GITLAB_ENABLED', 'GOTRUE_EXTERNAL_GITLAB_CLIENT_ID', 'GOTRUE_EXTERNAL_GITLAB_SECRET'] },
  { id: 'bitbucket', label: 'Bitbucket', kind: 'gotrue', gotrue: 'bitbucket', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_BITBUCKET_ENABLED', 'GOTRUE_EXTERNAL_BITBUCKET_CLIENT_ID', 'GOTRUE_EXTERNAL_BITBUCKET_SECRET'] },
  { id: 'facebook', label: 'Facebook', kind: 'gotrue', gotrue: 'facebook', redirect: 'gotrue', docs: 'https://developers.facebook.com/apps/',
    env: ['GOTRUE_EXTERNAL_FACEBOOK_ENABLED', 'GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID', 'GOTRUE_EXTERNAL_FACEBOOK_SECRET'] },
  { id: 'twitter', label: 'X (Twitter)', kind: 'gotrue', gotrue: 'twitter', redirect: 'gotrue', docs: 'https://developer.x.com/',
    env: ['GOTRUE_EXTERNAL_TWITTER_ENABLED', 'GOTRUE_EXTERNAL_TWITTER_CLIENT_ID', 'GOTRUE_EXTERNAL_TWITTER_SECRET'] },
  { id: 'spotify', label: 'Spotify', kind: 'gotrue', gotrue: 'spotify', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_SPOTIFY_ENABLED', 'GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID', 'GOTRUE_EXTERNAL_SPOTIFY_SECRET'] },
  { id: 'slack', label: 'Slack', kind: 'gotrue', gotrue: 'slack_oidc', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_SLACK_OIDC_ENABLED', 'GOTRUE_EXTERNAL_SLACK_OIDC_CLIENT_ID', 'GOTRUE_EXTERNAL_SLACK_OIDC_SECRET'] },
  { id: 'linkedin', label: 'LinkedIn', kind: 'gotrue', gotrue: 'linkedin_oidc', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED', 'GOTRUE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID', 'GOTRUE_EXTERNAL_LINKEDIN_OIDC_SECRET'] },
  { id: 'notion', label: 'Notion', kind: 'gotrue', gotrue: 'notion', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_NOTION_ENABLED', 'GOTRUE_EXTERNAL_NOTION_CLIENT_ID', 'GOTRUE_EXTERNAL_NOTION_SECRET'] },
  { id: 'figma', label: 'Figma', kind: 'gotrue', gotrue: 'figma', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_FIGMA_ENABLED', 'GOTRUE_EXTERNAL_FIGMA_CLIENT_ID', 'GOTRUE_EXTERNAL_FIGMA_SECRET'] },
  { id: 'kakao', label: 'Kakao', kind: 'gotrue', gotrue: 'kakao', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_KAKAO_ENABLED', 'GOTRUE_EXTERNAL_KAKAO_CLIENT_ID', 'GOTRUE_EXTERNAL_KAKAO_SECRET'] },
  { id: 'keycloak', label: 'Keycloak', kind: 'gotrue', gotrue: 'keycloak', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_KEYCLOAK_ENABLED', 'GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID', 'GOTRUE_EXTERNAL_KEYCLOAK_SECRET', 'GOTRUE_EXTERNAL_KEYCLOAK_URL'] },
  { id: 'workos', label: 'WorkOS', kind: 'gotrue', gotrue: 'workos', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_WORKOS_ENABLED', 'GOTRUE_EXTERNAL_WORKOS_CLIENT_ID', 'GOTRUE_EXTERNAL_WORKOS_SECRET'] },
  { id: 'zoom', label: 'Zoom', kind: 'gotrue', gotrue: 'zoom', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_ZOOM_ENABLED', 'GOTRUE_EXTERNAL_ZOOM_CLIENT_ID', 'GOTRUE_EXTERNAL_ZOOM_SECRET'] },
  { id: 'frontier', label: 'Frontier CAPI (источник игровых данных, не вход)', kind: 'builtin', redirect: 'none',
    docs: 'https://user.frontierstore.net/developer', env: ['FRONTIER_CLIENT_ID', 'FRONTIER_CLIENT_SECRET', 'FRONTIER_REDIRECT_URI'],
    note: 'Привязывается в профиле уже вошедшего пилота; на способы входа не влияет.' },
];

export const AUTH_PROVIDER_IDS = AUTH_PROVIDER_REGISTRY.map(item => item.id);
export function authProviderMeta(id: string) { return AUTH_PROVIDER_REGISTRY.find(item => item.id === id); }

export type AuthProviderSetting = {
  /** Show the button on /login and /account (for gotrue/site kinds). */
  enabled: boolean;
  client_id: string;
  /** Never returned to the browser; `has_secret` is. */
  client_secret?: string;
  notes: string;
  updated_at?: string;
};
export type AuthProviderSettings = Record<string, AuthProviderSetting>;

/** Which providers are visible by default when nothing was saved yet. */
export const DEFAULT_VISIBLE: Record<string, boolean> = { email: true, magiclink: true, discord: true, google: true, github: true, frontier: true };
// vk and everything else: hidden until an admin enables it.
