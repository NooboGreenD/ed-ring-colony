import { cookies } from 'next/headers';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { authError, authJson, EmailAuthError, readAuthBody } from '@/lib/emailAuth';
import { readRecoveryGrant, RECOVERY_COOKIE, sessionId } from '@/lib/passwordRecovery';
import { passwordError } from '@/lib/passwordPolicy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function recoverySession() {
  const store = await cookies();
  const grant = readRecoveryGrant(store.get(RECOVERY_COOKIE)?.value);
  if (!grant) throw new EmailAuthError('Откройте свежую ссылку восстановления из письма.', 401);
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user || user.id !== grant.userId) throw new EmailAuthError('Аккаунт изменился. Запросите новое письмо восстановления.', 401);
  const { data: { session } } = await client.auth.getSession();
  if (!session || sessionId(session.access_token) !== grant.sessionId) throw new EmailAuthError('Сессия изменилась. Запросите новое письмо.', 401);
  return { client, user };
}
export async function GET() {
  try { await recoverySession(); return authJson({ valid: true }); }
  catch (error) { return authError(error); }
}
export async function POST(request: Request) {
  try {
    const body = await readAuthBody(request, 'password');
    const problem = passwordError(body.password);
    if (problem) throw new EmailAuthError(problem);
    const { client, user } = await recoverySession();
    const { error } = await client.auth.updateUser({ password: body.password as string });
    if (error) throw new EmailAuthError('Не удалось изменить пароль. Выберите новый надёжный пароль или запросите свежую ссылку.');
    // Preserve history, but revoke bearer credentials after a recovery (including
    // credentials an attacker could have issued before a legitimate owner recovered).
    let warning: string | null = null;
    try {
      const { error: revokeError } = await createServiceClient().from('api_tokens')
        .update({ is_revoked: true }).eq('user_id', user.id);
      if (revokeError) throw revokeError;
    } catch {
      console.error('[auth/password] Could not revoke uploader tokens');
      warning = 'Не удалось отозвать токены Uploader. После входа отзовите их вручную в аккаунте или обратитесь к администратору.';
    }
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'global' });
      if (signOutError) throw signOutError;
    } catch {
      console.error('[auth/password] Could not revoke refresh sessions');
      warning = [warning, 'Пароль изменён, но отзыв прежних сеансов завершился не полностью. Обратитесь к администратору.'].filter(Boolean).join(' ');
    }
    const response = authJson({ ok: true, warning });
    response.cookies.delete(RECOVERY_COOKIE);
    return response;
  } catch (error) { return authError(error); }
}
