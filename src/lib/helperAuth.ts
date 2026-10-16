/**
 * Кто делает запрос: пилот с сессией сайта или Colonial Helper с API-токеном.
 *
 * `authFromRequest` понимает только сессию Supabase (cookie или JWT в
 * Authorization). Helper же ходит с API-токеном `rc_…` — в теле запроса или в
 * заголовке `Authorization: Bearer rc_…`. Раньше каждый маршрут повторял эту
 * проверку по-своему; здесь она одна.
 */

import { createHash } from 'node:crypto';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';

export interface RequestUser {
  userId: string;
  via: 'session' | 'api_token';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * JWT сессии Supabase всегда содержит точки, API-токен Helper'а — нет.
 * Длину не ограничиваем снизу: подлинность решает поиск по хешу в api_tokens.
 */
export function looksLikeApiToken(value: string): boolean {
  return value.length > 0 && value.length <= 1000 && !value.includes('.') && !/\s/.test(value);
}

async function userFromApiToken(token: string): Promise<string | null> {
  const svc = createServiceClient();
  const tokenHash = hashToken(token);
  const { data, error } = await svc
    .from('api_tokens')
    .select('user_id, is_revoked')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error || !data || data.is_revoked || !data.user_id) return null;
  // Отметка использования — не критична для ответа и не должна его ломать.
  try {
    const pending = svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
    if (pending && typeof pending.then === 'function') pending.then(() => undefined, () => undefined);
  } catch {
    // ignore
  }
  return String(data.user_id);
}

export async function resolveRequestUser(request: Request, bodyToken?: unknown): Promise<RequestUser | null> {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';

  if (bearer && looksLikeApiToken(bearer)) {
    const userId = await userFromApiToken(bearer);
    if (userId) return { userId, via: 'api_token' };
  } else {
    // Сессия сайта: cookie или Bearer JWT.
    try {
      const { user } = await authFromRequest(request);
      if (user) return { userId: user.id, via: 'session' };
    } catch {
      // Неисправная сессия не мешает проверить токен Helper'а ниже.
    }
  }

  const token = typeof bodyToken === 'string' ? bodyToken.trim() : '';
  if (token && looksLikeApiToken(token)) {
    const userId = await userFromApiToken(token);
    if (userId) return { userId, via: 'api_token' };
  }
  return null;
}
