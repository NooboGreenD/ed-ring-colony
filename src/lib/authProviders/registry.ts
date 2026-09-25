/**
 * Catalogue of sign-in services the site knows about. Browser-safe: no secrets.
 *
 * kind:
 *  - builtin — always part of Supabase Auth (e-mail/password, magic link)
 *  - gotrue  — OAuth provider handled by Supabase Auth (configured in GoTrue env,
 *              the site only decides whether to show the button)
 *  - site    — OAuth flow implemented by the site itself (VK ID, Яндекс ID);
 *              client id / secret may be stored here or in the web env
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
  redirect: 'gotrue' | 'site-vk' | 'site-yandex' | 'none';
  /** Env variables the admin needs to know about (names only). */
  env: string[];
  note?: string;
  /** Short how-to shown behind the «?» button in the admin panel. */
  help?: { steps: string[]; guide?: string; guideLabel?: string };
};

const GOTRUE_GUIDE = { guide: 'https://github.com/NooboGreenD/ed-ring-colony/blob/main/SELFHOST.md', guideLabel: 'SELFHOST.md → раздел «Discord»' };
/** Generic steps for any provider handled by Supabase Auth. */
function gotrueHelp(provider: string, console_: string, extra: string[] = []) {
  const upper = provider.toUpperCase();
  return { ...GOTRUE_GUIDE, steps: [
    `Создайте OAuth-приложение: ${console_}.`,
    'Redirect URI у провайдера: адрес «Redirect для GoTrue-провайдеров» выше (…/auth/v1/callback).',
    `В /opt/supabase/.env добавьте GOTRUE_EXTERNAL_${upper}_ENABLED=true, _CLIENT_ID и _SECRET; перезапустите сервис auth.`,
    `На сайте добавьте «${provider}» в AUTH_OAUTH_PROVIDERS (.env.production web) и перезапустите web.`,
    'Поставьте галочку «показывать» здесь — кнопка появится на /login и /account.',
    ...extra,
  ] };
}

export const GOTRUE_CALLBACK = '/auth/v1/callback';

export const AUTH_PROVIDER_REGISTRY: AuthProviderMeta[] = [
  { id: 'email', label: 'E-mail + пароль', kind: 'builtin', redirect: 'none',
    env: ['AUTH_EMAIL_ENABLED', 'GOTRUE_SMTP_*', 'DISABLE_SIGNUP'],
    note: 'Регистрация и восстановление требуют настроенного SMTP в GoTrue.' ,
    help: { guide: 'https://github.com/NooboGreenD/ed-ring-colony/blob/main/POST-MIGRATION.md', guideLabel: 'POST-MIGRATION.md → почта', steps: ['Вход по паролю работает всегда.', 'Для регистрации и восстановления настройте SMTP в GoTrue (GOTRUE_SMTP_HOST/PORT/USER/PASS, шаблоны писем с TokenHash).', 'Затем AUTH_EMAIL_ENABLED=true на сайте и DISABLE_SIGNUP=false в GoTrue.'] } },
  { id: 'magiclink', label: 'Magic link (вход по ссылке из письма)', kind: 'builtin', redirect: 'none',
    env: ['GOTRUE_SMTP_*', 'GOTRUE_MAILER_URLPATHS_*'] ,
    help: { steps: ['Использует те же SMTP-настройки GoTrue, что и e-mail.', 'Отдельной кнопки на сайте нет: ссылка приходит из формы восстановления/подтверждения.'] } },
  { id: 'discord', label: 'Discord', kind: 'gotrue', gotrue: 'discord', redirect: 'gotrue',
    docs: 'https://discord.com/developers/applications', env: ['GOTRUE_EXTERNAL_DISCORD_ENABLED', 'GOTRUE_EXTERNAL_DISCORD_CLIENT_ID', 'GOTRUE_EXTERNAL_DISCORD_SECRET'] ,
    help: gotrueHelp('discord', 'discord.com/developers → New Application → OAuth2', ['Scopes: identify email.']) },
  { id: 'google', label: 'Google', kind: 'gotrue', gotrue: 'google', redirect: 'gotrue',
    docs: 'https://console.cloud.google.com/apis/credentials', env: ['GOTRUE_EXTERNAL_GOOGLE_ENABLED', 'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', 'GOTRUE_EXTERNAL_GOOGLE_SECRET'] ,
    help: gotrueHelp('google', 'console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Web)', ['Настройте OAuth consent screen и добавьте домен сайта в Authorized domains.']) },
  { id: 'github', label: 'GitHub', kind: 'gotrue', gotrue: 'github', redirect: 'gotrue',
    docs: 'https://github.com/settings/developers', env: ['GOTRUE_EXTERNAL_GITHUB_ENABLED', 'GOTRUE_EXTERNAL_GITHUB_CLIENT_ID', 'GOTRUE_EXTERNAL_GITHUB_SECRET'] ,
    help: gotrueHelp('github', 'github.com/settings/developers → OAuth Apps → New') },
  { id: 'vk', label: 'VK ID', kind: 'site', redirect: 'site-vk',
    docs: 'https://id.vk.com/about/business/go', env: ['VK_ID_CLIENT_ID', 'VK_ID_CLIENT_SECRET'],
    note: 'Собственный OAuth 2.1 / PKCE поток сайта. Кнопка появляется только когда включено здесь И задан Client ID (здесь или в env). См. VK-ID-SETUP.md.' ,
    help: { guide: 'https://github.com/NooboGreenD/ed-ring-colony/blob/main/VK-ID-SETUP.md', guideLabel: 'VK-ID-SETUP.md (пошагово)', steps: ['id.vk.com/about/business/go → создать приложение, платформа Web, домен edringcolony.ru.', 'Доверенный Redirect URL: адрес «Redirect для VK ID» выше.', 'Примените миграцию supabase/migrations/20260923000000_vk_identities.sql.', 'Вставьте числовой ID приложения в поле Client ID ниже (или VK_ID_CLIENT_ID в env) и сохраните.', 'Поставьте галочку «показывать». Нужен SUPABASE_SERVICE_ROLE_KEY на сервере.'] } },
  { id: 'yandex', label: 'Яндекс ID', kind: 'site', redirect: 'site-yandex',
    docs: 'https://oauth.yandex.ru/', env: ['YANDEX_ID_CLIENT_ID', 'YANDEX_ID_CLIENT_SECRET'],
    note: 'Собственный OAuth 2.0 / PKCE поток сайта (в GoTrue Яндекса нет). Кнопка появляется только когда включено здесь И задан Client ID (здесь или в env). См. YANDEX-ID-SETUP.md.' ,
    help: { guide: 'https://github.com/NooboGreenD/ed-ring-colony/blob/main/YANDEX-ID-SETUP.md', guideLabel: 'YANDEX-ID-SETUP.md (пошагово)', steps: ['oauth.yandex.ru → «Создать приложение», платформа «Веб-сервисы», Callback URI = адрес «Redirect для Яндекс ID» выше.', 'В доступах отметьте: Яндекс ID — почта (login:email), основная информация (login:info), аватарка (login:avatar).', 'Примените миграцию supabase/migrations/20260925010000_yandex_identities.sql.', 'Вставьте ClientID (32 hex-символа) и Client secret из кабинета Яндекса ниже (или YANDEX_ID_CLIENT_ID/SECRET в env) и сохраните.', 'Поставьте галочку «показывать». Нужен SUPABASE_SERVICE_ROLE_KEY на сервере.'] } },
  { id: 'telegram', label: 'Telegram Login', kind: 'planned', redirect: 'none', docs: 'https://core.telegram.org/widgets/login',
    env: ['TELEGRAM_BOT_TOKEN'], note: 'Виджет с подписью HMAC от бота; отдельная реализация.' ,
    help: { steps: ['Пока не реализовано. @BotFather → /newbot → /setdomain edringcolony.ru.', 'Login Widget присылает данные с HMAC-подписью токеном бота; проверка на сервере.', 'Токен бота можно сохранить в поле Client Secret заранее.'] } },
  { id: 'steam', label: 'Steam (OpenID)', kind: 'planned', redirect: 'none', docs: 'https://steamcommunity.com/dev',
    env: ['STEAM_WEB_API_KEY'], note: 'OpenID 2.0, без e-mail; полезно для привязки к игровому аккаунту.' ,
    help: { steps: ['Пока не реализовано. steamcommunity.com/dev/apikey → ключ Web API для домена.', 'Steam использует OpenID 2.0 без e-mail — подходит только для привязки к уже созданному аккаунту.'] } },
  { id: 'apple', label: 'Apple', kind: 'gotrue', gotrue: 'apple', redirect: 'gotrue', docs: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    env: ['GOTRUE_EXTERNAL_APPLE_ENABLED', 'GOTRUE_EXTERNAL_APPLE_CLIENT_ID', 'GOTRUE_EXTERNAL_APPLE_SECRET'] ,
    help: gotrueHelp('apple', 'developer.apple.com → Certificates, IDs & Profiles → Services ID', ['Секрет — JWT, подписанный ключом .p8; его нужно перегенерировать раз в 6 месяцев.']) },
  { id: 'azure', label: 'Microsoft (Azure / Entra ID)', kind: 'gotrue', gotrue: 'azure', redirect: 'gotrue', docs: 'https://portal.azure.com/',
    env: ['GOTRUE_EXTERNAL_AZURE_ENABLED', 'GOTRUE_EXTERNAL_AZURE_CLIENT_ID', 'GOTRUE_EXTERNAL_AZURE_SECRET'] ,
    help: gotrueHelp('azure', 'portal.azure.com → Microsoft Entra ID → App registrations', ['При необходимости задайте GOTRUE_EXTERNAL_AZURE_URL для конкретного tenant.']) },
  { id: 'twitch', label: 'Twitch', kind: 'gotrue', gotrue: 'twitch', redirect: 'gotrue', docs: 'https://dev.twitch.tv/console/apps',
    env: ['GOTRUE_EXTERNAL_TWITCH_ENABLED', 'GOTRUE_EXTERNAL_TWITCH_CLIENT_ID', 'GOTRUE_EXTERNAL_TWITCH_SECRET'] ,
    help: gotrueHelp('twitch', 'dev.twitch.tv/console/apps → Register Your Application') },
  { id: 'gitlab', label: 'GitLab', kind: 'gotrue', gotrue: 'gitlab', redirect: 'gotrue', docs: 'https://gitlab.com/-/user_settings/applications',
    env: ['GOTRUE_EXTERNAL_GITLAB_ENABLED', 'GOTRUE_EXTERNAL_GITLAB_CLIENT_ID', 'GOTRUE_EXTERNAL_GITLAB_SECRET'] ,
    help: gotrueHelp('gitlab', 'gitlab.com → User Settings → Applications (scope read_user)') },
  { id: 'bitbucket', label: 'Bitbucket', kind: 'gotrue', gotrue: 'bitbucket', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_BITBUCKET_ENABLED', 'GOTRUE_EXTERNAL_BITBUCKET_CLIENT_ID', 'GOTRUE_EXTERNAL_BITBUCKET_SECRET'] ,
    help: gotrueHelp('bitbucket', 'bitbucket.org → Workspace settings → OAuth consumers') },
  { id: 'facebook', label: 'Facebook', kind: 'gotrue', gotrue: 'facebook', redirect: 'gotrue', docs: 'https://developers.facebook.com/apps/',
    env: ['GOTRUE_EXTERNAL_FACEBOOK_ENABLED', 'GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID', 'GOTRUE_EXTERNAL_FACEBOOK_SECRET'] ,
    help: gotrueHelp('facebook', 'developers.facebook.com → My Apps → Facebook Login') },
  { id: 'twitter', label: 'X (Twitter)', kind: 'gotrue', gotrue: 'twitter', redirect: 'gotrue', docs: 'https://developer.x.com/',
    env: ['GOTRUE_EXTERNAL_TWITTER_ENABLED', 'GOTRUE_EXTERNAL_TWITTER_CLIENT_ID', 'GOTRUE_EXTERNAL_TWITTER_SECRET'] ,
    help: gotrueHelp('twitter', 'developer.x.com → Projects & Apps → User authentication settings') },
  { id: 'spotify', label: 'Spotify', kind: 'gotrue', gotrue: 'spotify', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_SPOTIFY_ENABLED', 'GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID', 'GOTRUE_EXTERNAL_SPOTIFY_SECRET'] ,
    help: gotrueHelp('spotify', 'developer.spotify.com/dashboard → Create app') },
  { id: 'slack', label: 'Slack', kind: 'gotrue', gotrue: 'slack_oidc', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_SLACK_OIDC_ENABLED', 'GOTRUE_EXTERNAL_SLACK_OIDC_CLIENT_ID', 'GOTRUE_EXTERNAL_SLACK_OIDC_SECRET'] ,
    help: gotrueHelp('slack_oidc', 'api.slack.com/apps → Create New App → OpenID Connect') },
  { id: 'linkedin', label: 'LinkedIn', kind: 'gotrue', gotrue: 'linkedin_oidc', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED', 'GOTRUE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID', 'GOTRUE_EXTERNAL_LINKEDIN_OIDC_SECRET'] ,
    help: gotrueHelp('linkedin_oidc', 'linkedin.com/developers/apps → продукт «Sign In with LinkedIn using OpenID Connect»') },
  { id: 'notion', label: 'Notion', kind: 'gotrue', gotrue: 'notion', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_NOTION_ENABLED', 'GOTRUE_EXTERNAL_NOTION_CLIENT_ID', 'GOTRUE_EXTERNAL_NOTION_SECRET'] ,
    help: gotrueHelp('notion', 'notion.so/my-integrations → Public integration') },
  { id: 'figma', label: 'Figma', kind: 'gotrue', gotrue: 'figma', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_FIGMA_ENABLED', 'GOTRUE_EXTERNAL_FIGMA_CLIENT_ID', 'GOTRUE_EXTERNAL_FIGMA_SECRET'] ,
    help: gotrueHelp('figma', 'figma.com/developers/apps → Create a new app') },
  { id: 'kakao', label: 'Kakao', kind: 'gotrue', gotrue: 'kakao', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_KAKAO_ENABLED', 'GOTRUE_EXTERNAL_KAKAO_CLIENT_ID', 'GOTRUE_EXTERNAL_KAKAO_SECRET'] ,
    help: gotrueHelp('kakao', 'developers.kakao.com → My Application → Kakao Login') },
  { id: 'keycloak', label: 'Keycloak', kind: 'gotrue', gotrue: 'keycloak', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_KEYCLOAK_ENABLED', 'GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID', 'GOTRUE_EXTERNAL_KEYCLOAK_SECRET', 'GOTRUE_EXTERNAL_KEYCLOAK_URL'] ,
    help: gotrueHelp('keycloak', 'ваш Keycloak → Clients → Create (OpenID Connect)', ['Обязательно GOTRUE_EXTERNAL_KEYCLOAK_URL=https://<host>/realms/<realm>.']) },
  { id: 'workos', label: 'WorkOS', kind: 'gotrue', gotrue: 'workos', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_WORKOS_ENABLED', 'GOTRUE_EXTERNAL_WORKOS_CLIENT_ID', 'GOTRUE_EXTERNAL_WORKOS_SECRET'] ,
    help: gotrueHelp('workos', 'dashboard.workos.com → Configuration → Redirect URI') },
  { id: 'zoom', label: 'Zoom', kind: 'gotrue', gotrue: 'zoom', redirect: 'gotrue',
    env: ['GOTRUE_EXTERNAL_ZOOM_ENABLED', 'GOTRUE_EXTERNAL_ZOOM_CLIENT_ID', 'GOTRUE_EXTERNAL_ZOOM_SECRET'] ,
    help: gotrueHelp('zoom', 'marketplace.zoom.us → Develop → Build App (OAuth)') },
  { id: 'frontier', label: 'Frontier CAPI (источник игровых данных, не вход)', kind: 'builtin', redirect: 'none',
    docs: 'https://user.frontierstore.net/developer', env: ['FRONTIER_CLIENT_ID', 'FRONTIER_CLIENT_SECRET', 'FRONTIER_REDIRECT_URI'],
    note: 'Привязывается в профиле уже вошедшего пилота; на способы входа не влияет.' ,
    help: { guide: 'https://github.com/NooboGreenD/ed-ring-colony/blob/main/README.md', guideLabel: 'README.md → CAPI', steps: ['Встроенный Client ID уже работает; свой — user.frontierstore.net/developer.', 'Redirect URI: https://edringcolony.ru/api/capi/callback и http://127.0.0.1/ (Uploader).', 'Пилот привязывает Frontier сам в /account; это источник игровых данных, не способ входа.'] } },
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
