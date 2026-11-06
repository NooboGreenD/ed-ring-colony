'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function EmailRequestForm({ type }: { type: 'recovery' | 'signup' }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(false), 60_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const response = await fetch('/api/auth/email/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, email }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || t('ef.sendFailed')); return; }
      setMessage(result.message); setCooldown(true);
    } catch { setError(t('ef.connectionRetry')); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <div className="kicker">{t('ef.kicker')}</div>
    <h1>{type === 'recovery' ? t('ef.recoverTitle') : t('ef.confirmTitle')}</h1>
    <p>{type === 'recovery' ? t('ef.recoverNote') : t('ef.confirmNote')}</p>
    <form className="auth-form" onSubmit={submit}>
      <label>Email<input type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy || cooldown}>{busy ? t('ef.sending') : cooldown ? t('ef.cooldown') : t('ef.submit')}</button>
    </form>
    <p className="auth-switch"><Link href="/login">{t('ef.backToLogin')}</Link></p>
  </main>;
}
