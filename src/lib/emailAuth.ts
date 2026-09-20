import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { checkRateLimit } from '@/lib/rateLimit';
import { getSiteUrl } from '@/lib/siteUrl';

export class EmailAuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function emailAuthEnabled() { return process.env.AUTH_EMAIL_ENABLED === 'true'; }
export function authJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}
export function authError(error: unknown) {
  return error instanceof EmailAuthError ? authJson({ error: error.message }, error.status)
    : authJson({ error: 'Сервис авторизации временно недоступен. Попробуйте позже.' }, 503);
}

/** The public port must be behind the trusted proxy, which overwrites X-Real-IP. */
export function authRequestIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  const value = request.headers.get('x-real-ip') || forwarded || '';
  return isIP(value) ? value : 'unknown';
}
export async function readAuthBody(request: Request, scope: string): Promise<Record<string, unknown>> {
  // All browser POSTs are JSON + same-origin. Do not derive trust from Host/X-Forwarded-Host.
  if (request.headers.get('origin') !== getSiteUrl()) {
    throw new EmailAuthError('Запрос должен быть отправлен с сайта.', 403);
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new EmailAuthError('Ожидается JSON.', 415);
  }
  if (!checkRateLimit(`email:${scope}:${authRequestIp(request)}`, 5)) {
    throw new EmailAuthError('Слишком много попыток. Подождите минуту.', 429);
  }
  const limit = 8192;
  if (Number(request.headers.get('content-length')) > limit) throw new EmailAuthError('Слишком большой запрос.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new EmailAuthError('Пустой запрос.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new EmailAuthError('Слишком большой запрос.', 413); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch (error) {
    if (error instanceof EmailAuthError) throw error;
    throw new EmailAuthError('Некорректный JSON.');
  } finally { reader.releaseLock(); }
}
export function normalizedEmail(value: unknown) {
  if (typeof value !== 'string') throw new EmailAuthError('Укажите email.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EmailAuthError('Укажите корректный email.');
  return email;
}
export function publicAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new EmailAuthError('Сервис авторизации не настроен.', 503);
  return createClient(url, key, { auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    // Email templates use TokenHash, not implicit access tokens or a device-bound verifier.
    flowType: 'implicit',
  } });
}
/** Fail closed if GoTrue would silently auto-confirm an attacker-supplied email. */
export async function requireEmailDelivery(signup = false, fetchImpl = fetch) {
  if (!emailAuthEnabled()) throw new EmailAuthError('Отправка писем временно недоступна. Обратитесь к администратору.', 503);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new EmailAuthError('Сервис авторизации не настроен.', 503);
  const response = await fetchImpl(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
    headers: { apikey: key }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new EmailAuthError('Не удалось проверить настройки авторизации.', 503);
  const settings = await response.json();
  if (settings.mailer_autoconfirm !== false || settings.external?.email === false) {
    throw new EmailAuthError('Подтверждение почты не настроено. Обратитесь к администратору.', 503);
  }
  if (signup && settings.disable_signup !== false) throw new EmailAuthError('Новые регистрации временно закрыты.', 503);
}
export const EMAIL_SENT_MESSAGE = 'Если адрес подходит для этой операции, письмо отправлено. Проверьте входящие и спам. Повторить запрос можно через минуту.';
