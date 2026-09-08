'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function RegisterPage() {
  const router = useRouter();
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
    if (password.length < 6) {
      setError('Пароль должен быть не короче 6 символов.');
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
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, cmdr_name: nick }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setError(payload.error || 'Не удалось создать аккаунт.');
      return;
    }
    const { error: loginErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (loginErr) {
      setInfo('Аккаунт создан. Войдите на странице входа.');
      return;
    }
    router.push('/account');
    router.refresh();
  };

  return (
    <main className="card auth-card">
      <div className="kicker">Новый пилот</div>
      <h1>Регистрация</h1>
      {info ? (
        <p>{info}</p>
      ) : (
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            Никнейм / CMDR
            <input
              type="text"
              required
              autoComplete="nickname"
              placeholder="CMDR Name"
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
