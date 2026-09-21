import { authError, authJson, EmailAuthError, normalizedEmail, publicAuthClient,
  readAuthBody, requireEmailDelivery, EMAIL_SENT_MESSAGE } from '@/lib/emailAuth';
import { getSiteUrl } from '@/lib/siteUrl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readAuthBody(request, 'send');
    const email = normalizedEmail(body.email);
    if (!['recovery', 'signup'].includes(String(body.type))) throw new EmailAuthError('Неизвестный тип письма.');
    await requireEmailDelivery(body.type === 'signup');
    const client = publicAuthClient();
    const redirectTo = `${getSiteUrl()}/auth/email`;
    const { error } = body.type === 'recovery'
      ? await client.auth.resetPasswordForEmail(email, { redirectTo })
      : await client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectTo } });
    // Do not disclose whether an account exists (including errors on existing
    // accounts only, e.g. SMTP/GoTrue per-user rate limits). No provider error/PII in logs.
    if (error) console.warn('[auth/email/request] Email request was not completed; inspect GoTrue/SMTP logs');
    return authJson({ ok: true, message: EMAIL_SENT_MESSAGE }, 202);
  } catch (error) { return authError(error); }
}
