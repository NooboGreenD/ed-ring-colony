'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { startDiscordOAuth } from '@/lib/discordOAuth';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const discord = async () => {
    setError('');
    const { error: err } = await startDiscordOAuth(supabase, 'login');
    if (err) setError(err);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) {
      setBusy(false);
      setError(err.message === 'Invalid login credentials' ? 'Неверный логин или пароль.' : err.message);
      return;
    }
    await fetch('/api/auth/ensure-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
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
