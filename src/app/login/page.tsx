'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch, supabase } from '@/lib/supabaseClient';
import AuthMethods from '@/components/AuthMethods';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError || !data.session || !data.user) {
        setError(
          signInError?.message === 'Invalid login credentials'
            ? t('lg.badCredentials')
            : signInError?.code === 'email_not_confirmed'
              ? t('lg.confirmEmail')
              : signInError?.message || t('lg.sessionFailed'),
        );
        return;
      }

      // The browser client has now persisted the standard Supabase cookie
      // session. Send its current Bearer token so profile creation works even
      // before a subsequent request has picked up that cookie. A nickname is
      // deliberately not sent here: an existing profile is the source of
      // truth after a user has edited it.
      try {
        const profileResponse = await authFetch('/api/auth/ensure-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: data.user.id,
            email: data.user.email,
          }),
        });

        if (!profileResponse.ok) {
          console.warn('[Login] Could not ensure profile:', profileResponse.status);
        }
      } catch (profileError) {
        // A profile retry is available from /account. Do not turn a valid
        // Supabase login into a failed login because this best-effort request
        // is temporarily unavailable.
        console.warn('[Login] Could not ensure profile:', profileError);
      }

      router.replace('/account');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('lg.loginError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="card auth-card">
      <div className="kicker">{t('lg.kicker')}</div>
      <h1>{t('lg.title')}</h1>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          {t('register.password')}
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t('lg.busy') : t('login.submit')}
        </button>
      </form>
      <p className="auth-switch"><Link href="/forgot-password">{t('login.forgot')}</Link> · <Link href="/resend-confirmation">{t('lg.confirmEmailLink')}</Link></p>
      <p className="auth-switch">
        {t('lg.noAccount')} <Link href="/register">{t('login.register')}</Link>
      </p>
      <div className="auth-or">{t('lg.or')}</div>
      <AuthMethods disabled={busy} />
    </main>
  );
}
