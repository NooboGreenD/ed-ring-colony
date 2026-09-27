import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { assessProfileBinding } from '@/lib/capi/profileBinding';

export const dynamic = 'force-dynamic';

/**
 * Данные CAPI и состояние привязки к `profiles.id`.
 *
 * Ключевая деталь: «привязан ли аккаунт» определяется НАЛИЧИЕМ ТОКЕНА, а не
 * строкой в `capi_profiles`. Интерфейс раньше судил по профилю, поэтому при
 * живой привязке, но пустом профиле (CAPI на техобслуживании, командир ещё
 * не заходил в игру, отставшая схема БД) показывал «Подключите Frontier
 * Account» — и пилот справедливо считал, что привязка не сработала.
 */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const [{ data: profile }, { data: siteProfile }, { data: token }] = await Promise.all([
    svc.from('capi_profiles').select('*').eq('user_id', user.id).maybeSingle(),
    svc.from('profiles').select('cmdr_name').eq('id', user.id).maybeSingle(),
    svc.from('capi_tokens').select('*').eq('user_id', user.id).maybeSingle(),
  ]);

  const binding = assessProfileBinding(siteProfile?.cmdr_name, profile?.cmdr_name ?? token?.cmdr_name);
  const expiresAt = token?.expires_at ? Date.parse(token.expires_at) : NaN;

  return NextResponse.json({
    profile,
    binding: {
      ...binding,
      userId: user.id,
      capiName: profile?.cmdr_name ?? token?.cmdr_name ?? null,
      siteName: siteProfile?.cmdr_name ?? null,
      /** Привязка существует: токен сохранён и не отозван. */
      linked: Boolean(token),
      tokenActive: Boolean(token) && token?.is_active !== false,
      /** Access-токен просрочен — это норма, его обновит ближайший синк. */
      accessExpired: Number.isFinite(expiresAt) ? expiresAt <= Date.now() : null,
      expiresAt: token?.expires_at ?? null,
      linkedAt: token?.linked_at ?? token?.created_at ?? null,
      platform: token?.platform ?? null,
      frontierId: token?.frontier_id ?? null,
      lastError: token?.last_error ?? null,
      lastSyncedAt: token?.last_synced_at ?? profile?.last_updated ?? null,
    },
  });
}
