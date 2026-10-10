// ═══════════════════════════════════════════════════════════════
// Frontier CAPI OAuth 2.0 — без Shared Key (PKCE)
// ═══════════════════════════════════════════════════════════════
//
// Зачем этот файл переписан
// -------------------------
// Раньше обмен кода на токен требовал `FRONTIER_CLIENT_SECRET` («Shared Key»
// из Developer Zone Frontier). Этот ключ выдаёт только FDEV по заявке, и без
// него интеграция просто не работала.
//
// Shared Key нужен исключительно «конфиденциальным» клиентам, которые
// аутентифицируются секретом при обмене refresh-токена. Для клиента с потоком
// **PKCE** (authorization code + code_challenge) секрет не требуется вовсе:
// доказательством служит `code_verifier`, который знает только тот, кто начал
// авторизацию. Именно так работают десктопные инструменты сообщества (EDMC,
// EDDI и др.) — см. `docs/FrontierDevelopments-oAuth2-notes.md` в
// github.com/Athanasius/fd-api:
//
//   Authorization: https://auth.frontierstore.net/auth?audience=frontier,steam,epic
//                  &scope=auth capi&response_type=code&client_id=…
//                  &code_challenge=…&code_challenge_method=S256&state=…
//                  &redirect_uri=…
//   Token:         grant_type=authorization_code&code=…&code_verifier=…
//                  &client_id=…&redirect_uri=…        ← без client_secret
//   Refresh:       grant_type=refresh_token&client_id=…&refresh_token=…
//                                                   ← тоже без client_secret
//
// Особенности Frontier, которые здесь учтены:
//   • `code_challenge` — URL-safe base64 от SHA-256 верификатора БЕЗ «=»;
//     с «=» сервер отвечает {"message":"An error occured."}.
//   • `code_verifier` — URL-safe base64, и «=» в конце ОБЯЗАТЕЛЬНО остаётся.
//   • `audience` — платформы аккаунта. По умолчанию `frontier,steam,epic`
//     (как в EDMC): один лишь `frontier` даёт токен учётки магазина, и
//     CAPI отвечает `400 Please Visit the store to purchase Elite:
//     Dangerous` пилотам, купившим игру в Steam или Epic.
//   • Access-токен живёт ~4 часа (expires_in = 14400), CAPI отвечает HTTP 422,
//     когда он истёк; refresh-токен работает не дольше 25 дней с момента
//     авторизации, после чего нужна повторная авторизация пользователя.
//
// Что остаётся от пользователя: только Client ID. Проект зарегистрировал
// собственное приложение «ED Ring Colony» в Developer Zone
// (https://user.frontierstore.net) — его ключ используется по умолчанию,
// поэтому диалог согласия Frontier показывает имя нашего сервиса.
// `FRONTIER_CLIENT_ID` переопределяет его (например, для отдельного стенда).

import { createHash, randomBytes } from 'crypto';
// Относительные пути с расширением — сознательно: эти модули грузит не
// только сборка Next, но и `node --test` напрямую, а он про алиас `@/`
// ничего не знает (см. scripts/tests/capi-pkce.test.mjs).
import { getSiteUrl } from '../siteUrl.ts';
import { capiUserAgent } from './client.ts';
import { normalizeAudience, normalizePlatform } from './platform.ts';
export { DEFAULT_AUDIENCE, FRONTIER_AUDIENCES, normalizeAudience } from './platform.ts';
export type { FrontierAudience } from './platform.ts';

const FRONTIER_AUTH_URL = 'https://auth.frontierstore.net/auth';
const FRONTIER_TOKEN_URL = 'https://auth.frontierstore.net/token';
/** Проверяет access-токен и возвращает его содержимое (Frontier ID, e-mail). */
export const FRONTIER_DECODE_URL = 'https://auth.frontierstore.net/decode';
export const FRONTIER_ME_URL = 'https://auth.frontierstore.net/me';

/**
 * Client ID приложения «ED Ring Colony» в Frontier Developer Zone (CAPI).
 *
 * Публичный PKCE-клиент без секрета: используется сайтом и десктопным
 * Colonial Helper. Переопределяется `FRONTIER_CLIENT_ID`.
 */
export const FRONTIER_APP_CLIENT_ID = '0d6027a7-2561-4e1b-af2e-2fe71b296bdd';

/**
 * Client ID официального компаньон-приложения Elite Dangerous — запасной
 * публичный клиент (им пользуются EDMC/EDDI). Оставлен для совместимости.
 */
export const FRONTIER_PUBLIC_CLIENT_ID = '2360653316734633';

export function frontierClientId(): string {
  return (process.env.FRONTIER_CLIENT_ID || FRONTIER_APP_CLIENT_ID).trim();
}

/**
 * Есть ли «секретный» режим. Он не обязателен: при PKCE секрет не нужен.
 * Если `FRONTIER_CLIENT_SECRET` всё же задан (собственный конфиденциальный
 * клиент), мы его используем — это не ломает PKCE.
 */
export function frontierClientSecret(): string | null {
  const secret = (process.env.FRONTIER_CLIENT_SECRET || '').trim();
  return secret || null;
}

export function isPkceConfigured(): boolean {
  // PKCE работает без секрета, поэтому «настроен» = есть куда возвращаться.
  return Boolean(frontierRedirectUri());
}

/** Путь колбэка на сайте. Он же зарегистрирован в Developer Zone Frontier. */
export const FRONTIER_CALLBACK_PATH = '/api/capi/callback';

/**
 * Куда Frontier вернёт пользователя.
 *
 * `FRONTIER_REDIRECT_URI` — приоритет (отдельный стенд, свой клиент). Если
 * переменная не задана, берём публичный адрес сайта: раньше пустое значение
 * роняло `buildAuthUrl` ещё до редиректа, и «привязка» заканчивалась белой
 * страницей ошибки без единого объяснения. Адрес обязан совпадать с
 * зарегистрированным у Frontier до символа.
 */
export function frontierRedirectUri(): string {
  const configured = (process.env.FRONTIER_REDIRECT_URI || '').trim();
  if (configured) return configured;

  try {
    return `${getSiteUrl()}${FRONTIER_CALLBACK_PATH}`;
  } catch {
    // NEXT_PUBLIC_SITE_URL задан некорректно — пусть вызывающий код скажет
    // об этом человеческим языком.
    return '';
  }
}

/* ── PKCE ─────────────────────────────────────────────────────────── */

/** URL-safe base64. `pad` = оставить «=» (верификатор) или снять (challenge). */
function base64Url(buffer: Buffer, pad: boolean): string {
  const encoded = buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return pad ? encoded : encoded.replace(/=+$/, '');
}

/** 32 случайных байта → верификатор. «=» в конце сохраняется — так требует Frontier. */
export function createCodeVerifier(): string {
  return base64Url(randomBytes(32), true);
}

/** SHA-256 от верификатора → challenge. «=» ОБЯЗАТЕЛЬНО снимаем. */
export function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'utf8').digest(), false);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = createCodeVerifier();
  return { verifier, challenge: createCodeChallenge(verifier) };
}

/* ── Шаг 1: ссылка на авторизацию ─────────────────────────────────── */

export interface AuthUrlOptions {
  state: string;
  /** Обязателен для PKCE; без него получаем «конфиденциальный» поток. */
  codeChallenge?: string;
  /** Переопределение redirect_uri (например, loopback для десктоп-клиента). */
  redirectUri?: string;
  clientId?: string;
  /** Платформа аккаунта: 'frontier' | 'steam' | 'epic' | 'xbox' | 'psn',
   *  список через запятую или пусто = `frontier,steam,epic` (как в EDMC). */
  audience?: string;
  scope?: string;
}

export function buildAuthUrl(state: string, options: Omit<AuthUrlOptions, 'state'> = {}): string {
  const clientId = (options.clientId || frontierClientId()).trim();
  const redirectUri = (options.redirectUri || frontierRedirectUri()).trim();
  if (!redirectUri) {
    throw new Error('FRONTIER_REDIRECT_URI not configured');
  }

  const params = new URLSearchParams({
    // Без нормализации сюда легко уехало бы 'frontier' — самая частая
    // причина 400 у CAPI для пилотов со Steam/Epic.
    audience: normalizeAudience(options.audience),
    // 'auth capi' — доступ к Companion API. 'auth' дал бы только e-mail/имя.
    scope: options.scope || 'auth capi',
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  if (options.codeChallenge) {
    params.set('code_challenge', options.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  return `${FRONTIER_AUTH_URL}?${params.toString()}`;
}

/* ── Шаг 2: обмен кода на токены ──────────────────────────────────── */

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Ошибка сервера авторизации Frontier с сохранённым кодом ответа.
 *
 * Код нужен, чтобы отличать «пилот больше не авторизован» (400/401 — код
 * использован повторно, refresh-токен старше 25 дней) от временной аварии
 * (5xx, сеть). В первом случае привязку надо помечать неактивной и просить
 * пройти авторизацию заново, во втором — просто повторить позже.
 */
export class FrontierAuthError extends Error {
  readonly status: number;
  readonly body: string;
  /** Пилоту нужно заново пройти авторизацию: токен уже не восстановить. */
  readonly needsReauth: boolean;

  constructor(status: number, body: string) {
    super(`Frontier token error: ${status} ${body}`.trim());
    this.name = 'FrontierAuthError';
    this.status = status;
    this.body = body;
    this.needsReauth = status === 400 || status === 401 || status === 403;
  }
}

async function postForm(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(FRONTIER_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        // Frontier просит инструменты сообщества представляться по шаблону
        // EDCD-<App>-<version> — и на /auth, и на /token.
        'User-Agent': capiUserAgent(),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new FrontierAuthError(0, err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  if (!res.ok) {
    throw new FrontierAuthError(res.status, text.slice(0, 500));
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new FrontierAuthError(res.status, 'Frontier вернул нечитаемый ответ на запрос токена');
  }
}

export interface ExchangeCodeOptions {
  /** Верификатор PKCE. Без него нужен `FRONTIER_CLIENT_SECRET`. */
  codeVerifier?: string | null;
  redirectUri?: string;
  clientId?: string;
}

/**
 * Обменять authorization code на токены.
 *
 * PKCE-поток обходится без секрета: в теле запроса `code_verifier` вместо
 * `client_secret`. Секрет добавляется только если он явно настроен.
 */
export async function exchangeCode(
  code: string,
  options: ExchangeCodeOptions = {},
): Promise<TokenResponse> {
  const clientId = (options.clientId || frontierClientId()).trim();
  const redirectUri = (options.redirectUri || frontierRedirectUri()).trim();
  const clientSecret = frontierClientSecret();

  if (!options.codeVerifier && !clientSecret) {
    throw new Error('Either a PKCE code verifier or FRONTIER_CLIENT_SECRET is required');
  }
  if (!redirectUri) {
    throw new Error('FRONTIER_REDIRECT_URI not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  // «=» в конце верификатора сохраняем — Frontier сверяет строку как есть.
  if (options.codeVerifier) body.set('code_verifier', options.codeVerifier);
  if (clientSecret) body.set('client_secret', clientSecret);

  return postForm(body);
}

/**
 * Обновить access-токен.
 *
 * Для PKCE-клиентов секрет не нужен: `client_id` + `refresh_token`.
 * Refresh-токен Frontier живёт не дольше 25 дней с момента авторизации —
 * после этого пользователю придётся пройти авторизацию заново.
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: { clientId?: string } = {},
): Promise<TokenResponse> {
  const clientId = (options.clientId || frontierClientId()).trim();
  const clientSecret = frontierClientSecret();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  return postForm(body);
}

/* ── Проверка токена без собственного клиента ─────────────────────── */

/**
 * Расшифровать access-токен на сервере Frontier (`/decode`).
 *
 * Зачем: данные пилота можно получать вообще без собственной OAuth-регистрации
 * на сайте. Десктопный Colonial Helper (или любой другой инструмент — EDMC,
 * EDDI) авторизуется сам и присылает сайту access-токен; сайт проверяет его
 * здесь, узнаёт Frontier ID/e-mail и командира, и доверяет загруженным данным.
 * Frontier лишь сверяет `exp` и расшифровывает JWT — своего ключа нам не надо.
 */
export async function decodeFrontierToken(
  accessToken: string,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  try {
    // /decode, как в EDMC, — GET с Bearer, не POST с токеном в форме.
    const res = await fetch(FRONTIER_DECODE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': capiUserAgent(),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const parsed: unknown = await res.json();
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    return { ok: res.ok, status: res.status, payload };
  } catch {
    return { ok: false, status: 0, payload: null };
  }
}

/**
 * Истёк ли access-токен. CAPI отвечает 422 (а не 401) на просроченный токен,
 * поэтому «нужен refresh» проверяем по обоим кодам.
 */
export function isTokenExpiredStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 422;
}

export interface FrontierIdentity {
  /** `customer_id` аккаунта Frontier — стабильный ключ привязки. */
  frontierId: string | null;
  email: string | null;
  /** 'frontier' | 'steam' | 'epic' | 'xbox' | 'psn'. */
  platform: string | null;
}

/** Оба формата Frontier: плоский /me и { usr: … } из /decode. */
export function parseFrontierIdentity(data: unknown): FrontierIdentity | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  const user = root.usr && typeof root.usr === 'object' && !Array.isArray(root.usr)
    ? root.usr as Record<string, unknown> : root;
  const id = user.customer_id ?? user.customerId;
  const frontierId = (typeof id === 'string' || typeof id === 'number') && String(id).trim()
    ? String(id).trim() : null;
  const platform = normalizePlatform(user.platform) ?? normalizePlatform(root.platform);
  if (!frontierId && !platform) return null;
  return {
    frontierId,
    email: typeof user.email === 'string' ? user.email : null,
    platform,
  };
}

/**
 * Узнать владельца токена через `GET /me`.
 *
 * Зачем: имя командира приходит из CAPI и может меняться, а `customer_id`
 * постоянен. Сохранённый `frontier_id` позволяет увидеть, что один и тот же
 * аккаунт Frontier пытаются привязать к двум учётным записям сайта, и не
 * выдавать чужие данные. Вызов необязательный: любая ошибка — просто null,
 * привязку она рвать не должна.
 */
export async function fetchFrontierIdentity(accessToken: string): Promise<FrontierIdentity | null> {
  let identity: FrontierIdentity | null = null;
  try {
    const res = await fetch(FRONTIER_ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': capiUserAgent(),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) identity = parseFrontierIdentity(await res.json());
  } catch {
    // /me может быть недоступен или отдавать только customer_id.
  }
  if (identity?.frontierId && identity.platform) return identity;

  const decoded = await decodeFrontierToken(accessToken);
  const fallback = decoded.ok ? parseFrontierIdentity(decoded.payload) : null;
  if (!fallback) return identity;
  // Не смешиваем данные разных владельцев даже при неожиданном ответе Frontier.
  if (identity?.frontierId && fallback.frontierId && identity.frontierId !== fallback.frontierId) return identity;
  return {
    frontierId: identity?.frontierId ?? fallback.frontierId,
    email: identity?.email ?? fallback.email,
    platform: identity?.platform ?? fallback.platform,
  };
}
