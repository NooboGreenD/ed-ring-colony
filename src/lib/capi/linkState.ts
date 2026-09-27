// ═══════════════════════════════════════════════════════════════
// Состояние потока привязки Frontier: cookies, подпись, статусы
// ═══════════════════════════════════════════════════════════════
//
// Три проблемы прежнего колбэка решаются здесь.
//
// 1. Cookie читались регуляркой `new RegExp(name + '=([^;]+)')` по всему
//    заголовку. Это находит и чужую cookie, имя которой заканчивается на
//    наше (`sb-capi_state`), и не разбирает процентное кодирование —
//    верификатор PKCE как раз кодируется, потому что заканчивается на «=».
//
// 2. Жизнь `capi_state`/`capi_pkce` — 10 минут. Вход на стороне Frontier с
//    подтверждением по почте регулярно занимает больше, и пользователь
//    возвращался на `?status=error&message=invalid_state`, пройдя все шаги.
//
// 3. Колбэк — переход с ЧУЖОГО домена. Если сессионная cookie Supabase по
//    какой-то причине не доехала (SameSite у прокси, приватный режим,
//    ITP), пользователь не опознавался и привязка молча не делалась.
//    Поэтому на старте потока, когда сессия точно есть, мы кладём
//    подписанную cookie `capi_link` с UUID пилота и в колбэке используем её
//    как запасной ключ. Подпись HMAC-SHA256 на серверном секрете — подделать
//    нельзя, срок жизни ограничен.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const CAPI_STATE_COOKIE = 'capi_state';
export const CAPI_PKCE_COOKIE = 'capi_pkce';
export const CAPI_LINK_COOKIE = 'capi_link';

/** Сколько живёт начатый поток авторизации (сек). Вход у Frontier не быстрый. */
export const CAPI_FLOW_TTL_SECONDS = 30 * 60;

/**
 * Разобрать заголовок Cookie в карту. Именно разобрать, а не искать
 * подстроку: имя сверяется целиком, значение декодируется.
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;

    const name = part.slice(0, separator).trim();
    if (!name) continue;

    const raw = part.slice(separator + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  return parseCookies(header)[name] ?? null;
}

/** Сравнение секретов без утечки времени; длины могут не совпадать. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Секрет подписи. Серверный ключ Supabase есть на любом стенде. */
export function linkStateSecret(): string {
  return (
    process.env.CAPI_STATE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
}

export function createOauthState(): string {
  return randomBytes(32).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Подписанная привязка «этот поток начал вот этот пилот».
 * Формат: `v1.<userId>.<срок в мс>.<подпись>`.
 */
export function signLinkState(
  userId: string,
  secret: string = linkStateSecret(),
  ttlSeconds: number = CAPI_FLOW_TTL_SECONDS,
  now: number = Date.now(),
): string | null {
  if (!secret || !userId) return null;
  const expires = now + ttlSeconds * 1000;
  const payload = `v1.${userId}.${expires}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** UUID пилота из подписанной cookie или null, если подпись/срок не те. */
export function verifyLinkState(
  value: string | null | undefined,
  secret: string = linkStateSecret(),
  now: number = Date.now(),
): string | null {
  if (!value || !secret) return null;

  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  const [, userId, expiresRaw, signature] = parts;
  const expires = Number(expiresRaw);
  if (!userId || !Number.isFinite(expires) || expires < now) return null;
  if (!safeEqual(signature, sign(`v1.${userId}.${expires}`, secret))) return null;

  return userId;
}

/* ── Статусы, которые видит пилот ─────────────────────────────── */

export type CapiLinkStatus = 'success' | 'partial' | 'error';

/**
 * Коды причин. Строки короткие и стабильные: они уезжают в URL и
 * разворачиваются в текст на странице `/account/capi`.
 */
export type CapiLinkReason =
  | 'not_logged_in'
  | 'invalid_state'
  | 'expired_state'
  | 'missing_code'
  | 'access_denied'
  | 'token_exchange_failed'
  | 'redirect_uri_missing'
  | 'token_save_failed'
  | 'profile_unavailable'
  | 'profile_empty'
  | 'profile_save_failed'
  | 'capi_maintenance'
  | 'already_linked_elsewhere'
  | 'unknown';

export interface CapiRedirectOptions {
  status: CapiLinkStatus;
  reason?: CapiLinkReason;
  /** Подробность от Frontier/Postgres — показываем как есть, но коротко. */
  detail?: string | null;
  binding?: string | null;
  cmdr?: string | null;
}

/** Куда вернуть пилота после колбэка, с понятным набором параметров. */
export function buildCapiRedirect(siteUrl: string, options: CapiRedirectOptions): URL {
  const target = new URL('/account/capi', siteUrl);
  target.searchParams.set('status', options.status);
  if (options.reason) target.searchParams.set('reason', options.reason);
  if (options.detail) target.searchParams.set('detail', options.detail.slice(0, 300));
  if (options.binding) target.searchParams.set('binding', options.binding);
  if (options.cmdr) target.searchParams.set('cmdr', options.cmdr);
  return target;
}
