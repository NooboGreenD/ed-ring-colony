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
//   Authorization: https://auth.frontierstore.net/auth?audience=frontier
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
//   • `audience=frontier` — аккаунт Frontier (не Steam/Xbox/PlayStation).
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

export function frontierRedirectUri(): string {
  return (process.env.FRONTIER_REDIRECT_URI || '').trim();
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
  /** 'frontier' | 'steam' | 'ps4' | 'xbox' — платформа аккаунта. */
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
    audience: options.audience || 'frontier',
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

async function postForm(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(FRONTIER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Frontier token error: ${res.status} ${errText}`);
  }

  return res.json();
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
  const res = await fetch(FRONTIER_DECODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ token: accessToken }),
  });

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }

  return { ok: res.ok, status: res.status, payload };
}

/**
 * Истёк ли access-токен. CAPI отвечает 422 (а не 401) на просроченный токен,
 * поэтому «нужен refresh» проверяем по обоим кодам.
 */
export function isTokenExpiredStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 422;
}
