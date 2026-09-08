'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { startDiscordOAuthAction } from './actions';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const discord = async () => {
    setError('');
    try {
      const url = await startDiscordOAuthAction('login');
      if (url) window.location.href = url;
    } catch (err: any) {
      setError(err.message || 'Ошибка Discord OAuth');
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      setBusy(false);
      setError(error?.message === 'Invalid login credentials' ? 'Неверный логин или пароль.' : error?.message || 'Ошибка входа');
      return;
    }

    // Создаём профиль если его нет, используя данные из метаданных пользователя
    // Важно: передаём cmdr_name только если он есть в метаданных
    const cmdrName = data.user.user_metadata?.cmdr_name;
    if (cmdrName) {
      await fetch('/api/auth/ensure-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: data.user.id,
          email: data.user.email,
          cmdr_name: cmdrName
        }),
      });
    } else {
      // Если cmdr_name нет в метаданных, просто проверяем существование профиля
      await fetch('/api/auth/ensure-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: data.user.id,
          email: data.user.email
        }),
      });
    }

    setBusy(false);
    router.push('/account');
    router.refresh();
  };

  return (
    <main className="card auth-card">
      <div className="kicker">Авторизация</div>
      <h1>Вход</h1>
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
          Пароль
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
          {busy ? 'Вход...' : 'Войти'}
        </button>
      </form>
      <p className="auth-switch">
        Нет аккаунта? <Link href="/register">Регистрация</Link>
      </p>
      <div className="auth-or">или</div>
      <button type="button" onClick={discord}>
        Войти через Discord
      </button>
    </main>
  );
}
