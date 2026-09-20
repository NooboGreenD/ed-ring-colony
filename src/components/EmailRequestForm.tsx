'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function EmailRequestForm({ type }: { type: 'recovery' | 'signup' }) {
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
      if (!response.ok) { setError(result.error || 'Не удалось отправить письмо.'); return; }
      setMessage(result.message); setCooldown(true);
    } catch { setError('Ошибка соединения. Повторите попытку.'); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <div className="kicker">Доступ к аккаунту</div>
    <h1>{type === 'recovery' ? 'Восстановить пароль' : 'Подтвердить почту'}</h1>
    <p>{type === 'recovery' ? 'Отправим ссылку для установки нового пароля.' : 'Повторно отправим ссылку подтверждения регистрации.'}</p>
    <form className="auth-form" onSubmit={submit}>
      <label>Email<input type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy || cooldown}>{busy ? 'Отправка…' : cooldown ? 'Повторить можно через минуту' : 'Отправить письмо'}</button>
    </form>
    <p className="auth-switch"><Link href="/login">Вернуться ко входу</Link></p>
  </main>;
}
