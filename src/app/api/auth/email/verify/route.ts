import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { authError, authJson, EmailAuthError, readAuthBody } from '@/lib/emailAuth';
import { getSiteUrl } from '@/lib/siteUrl';
import { ensureUserProfile } from '@/lib/ensureProfile';
import { createRecoveryGrant, RECOVERY_COOKIE, RECOVERY_TTL, sessionId } from '@/lib/passwordRecovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST only: mail scanners/GET prefetches cannot consume a confirmation link.
export async function POST(request: Request) {
  try {
    const body = await readAuthBody(request, 'verify');
    if ((body.type !== 'signup' && body.type !== 'recovery') ||
        typeof body.token_hash !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(body.token_hash)) {
      throw new EmailAuthError('Неверная ссылка. Запросите новое письмо.');
    }
    if (body.type === 'recovery' && !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new EmailAuthError('Восстановление не настроено.', 503);
    const cookieStore = await cookies();
    const jar = new Map(cookieStore.getAll().map(cookie => [cookie.name, cookie.value]));
    const staged: { name: string; value: string; options: CookieOptions }[] = [];
    const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
        setAll(items: typeof staged) { for (const item of items) { jar.set(item.name, item.value); staged.push(item); } },
      },
    });
    const { data, error } = await client.auth.verifyOtp({ type: body.type, token_hash: body.token_hash });
    if (error || !data.session) throw new EmailAuthError('Ссылка недействительна или уже использована. Запросите новое письмо.');
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user || user.id !== data.session.user.id) throw new EmailAuthError('Не удалось подтвердить пользователя.', 401);
    let grant: string | null = null;
    if (body.type === 'recovery') {
      const sid = sessionId(data.session.access_token);
      if (!sid) throw new EmailAuthError('Сессия восстановления не поддерживается этой версией GoTrue.', 503);
      grant = createRecoveryGrant(user.id, sid);
    }
    try { await ensureUserProfile(client, user); }
    catch { console.warn('[auth/email/verify] Profile will be retried from account'); }
    const response = authJson({ ok: true, next: grant ? '/reset-password' : '/account' });
    for (const cookie of staged) response.cookies.set(cookie.name, cookie.value, cookie.options);
    response.cookies.delete('sb-session');
    response.cookies.delete(RECOVERY_COOKIE);
    if (grant) response.cookies.set(RECOVERY_COOKIE, grant, {
      httpOnly: true, sameSite: 'lax', secure: getSiteUrl().startsWith('https:'), path: '/', maxAge: RECOVERY_TTL,
    });
    return response;
  } catch (error) { return authError(error); }
}
