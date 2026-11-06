'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { passwordError } from '@/lib/passwordPolicy';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [warning, setWarning] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/auth/password', { cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (active) {
        if (response.ok && result.valid) setReady(true);
        else setError(result.error || t('pw2.requestNew'));
      }
    }).catch(() => { if (active) setError(t('pw2.sessionCheckFailed')); });
    return () => { active = false; };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    const problem = passwordError(password);
    if (problem) { setError(problem); return; }
    if (password !== confirm) { setError(t('pw2.mismatch')); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || t('pw2.changeFailed')); return; }
      setPassword(''); setConfirm(''); setWarning(result.warning || ''); setDone(true);
    } catch { setError(t('pw2.connectionError')); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <h1>{t('pw2.title')}</h1>
    {done ? <div role="status">
      <p>{t('pw2.done')}</p>
      {warning && <p role="alert" className="auth-error">{warning}</p>}
      <a href="/login">{t('pw2.login')}</a>
    </div> : <>
      <p>{t('pw2.intro')}</p>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {ready && <form className="auth-form" onSubmit={submit}>
        <label>{t('pw2.passwordLabel')}<input type="password" autoComplete="new-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>{t('pw2.repeatPassword')}<input type="password" autoComplete="new-password" required value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
        <button disabled={busy}>{busy ? t('pw2.saving') : t('pw2.submit')}</button>
      </form>}
      <p><Link href="/forgot-password">{t('pw2.requestLink')}</Link></p>
    </>}
  </main>;
}
