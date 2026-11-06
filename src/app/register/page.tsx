'use client';

import { useState } from 'react';
import Link from 'next/link';
import { passwordError } from '@/lib/passwordPolicy';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function RegisterPage() {
  const { t } = useI18n();
  const [cmdr, setCmdr] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    const problem = passwordError(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirm) {
      setError(t('reg2.passwordMismatch'));
      return;
    }
    const nick = cmdr.trim();
    if (!nick) {
      setError(t('reg2.noNick'));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, cmdr_name: nick }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { setError(payload.error || t('reg2.mailFailed')); return; }
      setPassword(''); setConfirm('');
      setInfo(payload.message || t('reg2.mailSent'));
    } catch { setError(t('reg2.connectionError')); }
    finally { setBusy(false); }
  };

  return (
    <main className="card auth-card">
      <div className="kicker">{t('reg2.kicker')}</div>
      <h1>{t('register.title')}</h1>
      {info ? (
        <div role="status"><p>{info}</p><p>{t('reg2.noAutoLogin')}</p><Link href="/resend-confirmation">{t('reg2.resend')}</Link></div>
      ) : (
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            {t('reg2.nickname')}
            <input
              type="text"
              required
              autoComplete="nickname"
              placeholder="CMDR Name"
              maxLength={250}
              value={cmdr}
              onChange={(e) => setCmdr(e.target.value)}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            {t('register.password')}
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p>{t('reg2.passwordHint')}</p>
          <label>
            {t('reg2.repeatPassword')}
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? t('reg2.creating') : t('reg2.createAccount')}
          </button>
        </form>
      )}
      <p className="auth-switch">
        {t('reg2.haveAccount')} <Link href="/login">{t('account.login')}</Link>
      </p>
    </main>
  );
}
