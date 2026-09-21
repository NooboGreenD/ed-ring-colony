'use client';

import { useState } from 'react';
import Link from 'next/link';
import { passwordError } from '@/lib/passwordPolicy';

export default function RegisterPage() {
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
      setError('Пароли не совпадают.');
      return;
    }
    const nick = cmdr.trim();
    if (!nick) {
      setError('Укажите никнейм / CMDR.');
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
      if (!res.ok) { setError(payload.error || 'Не удалось отправить письмо.'); return; }
      setPassword(''); setConfirm('');
      setInfo(payload.message || 'Подтвердите адрес по ссылке в письме, чтобы войти.');
    } catch { setError('Ошибка соединения. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };

  return (
    <main className="card auth-card">
      <div className="kicker">Новый пилот</div>
      <h1>Регистрация</h1>
      {info ? (
        <div role="status"><p>{info}</p><p>Автоматического входа до подтверждения почты нет.</p><Link href="/resend-confirmation">Отправить письмо повторно</Link></div>
      ) : (
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            Никнейм / CMDR
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
            Пароль
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p>Не менее 12 символов. Можно использовать длинную парольную фразу.</p>
          <label>
            Повтор пароля
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
            {busy ? 'Создание...' : 'Создать аккаунт'}
          </button>
        </form>
      )}
      <p className="auth-switch">
        Уже есть аккаунт? <Link href="/login">Войти</Link>
      </p>
    </main>
  );
}
