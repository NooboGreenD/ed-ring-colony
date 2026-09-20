import { authError, authJson, EmailAuthError, normalizedEmail, publicAuthClient,
  readAuthBody, requireEmailDelivery, EMAIL_SENT_MESSAGE } from '@/lib/emailAuth';
import { passwordError } from '@/lib/passwordPolicy';
import { getSiteUrl } from '@/lib/siteUrl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readAuthBody(request, 'register');
    const email = normalizedEmail(body.email);
    const problem = passwordError(body.password);
    if (problem) throw new EmailAuthError(problem);
    const nickname = typeof body.cmdr_name === 'string' ? body.cmdr_name.trim() : '';
    if (!nickname || nickname.length > 250 || /[\x00-\x1f]/.test(nickname)) throw new EmailAuthError('Укажите никнейм / CMDR (до 250 символов).');
    await requireEmailDelivery(true);
    const client = publicAuthClient();
    // Never admin.createUser(email_confirm:true); no service-role profile upsert.
    // GoTrue sends a verification email. Duplicate addresses receive the same response.
    const { data, error } = await client.auth.signUp({
      email, password: body.password as string,
      options: { data: { cmdr_name: nickname }, emailRedirectTo: `${getSiteUrl()}/auth/email` },
    });
    if (data?.session) {
      await client.auth.signOut({ scope: 'global' });
      console.error('[auth/register] Unexpected auto-confirmed signup; check GoTrue configuration');
      throw new EmailAuthError('Подтверждение почты не настроено.', 503);
    }
    // Do not turn per-address delivery/rate-limit/duplicate errors into an
    // account-existence oracle. The UI validates the common password policy;
    // GoTrue/SMTP diagnostics stay on the server, never in the response.
    if (error) console.warn('[auth/register] Signup/email delivery was not completed; inspect GoTrue/SMTP logs');
    return authJson({ ok: true, confirmationRequired: true, message: EMAIL_SENT_MESSAGE }, 202);
  } catch (error) { return authError(error); }
}
