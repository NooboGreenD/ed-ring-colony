'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch, supabase } from '@/lib/supabaseClient';
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

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError || !data.session || !data.user) {
        setError(
          signInError?.message === 'Invalid login credentials'
            ? 'Неверный логин или пароль.'
            : signInError?.message || 'Не удалось создать сессию. Попробуйте ещё раз.',
        );
        return;
      }

      // The browser client has now persisted the standard Supabase cookie
      // session. Send its current Bearer token so profile creation works even
      // before a subsequent request has picked up that cookie.
      const cmdrName = data.user.user_metadata?.cmdr_name;
      try {
        const profileResponse = await authFetch('/api/auth/ensure-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: data.user.id,
            email: data.user.email,
            ...(cmdrName ? { cmdr_name: cmdrName } : {}),
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
      setError(err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
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
      <button type="button" onClick={discord} disabled={busy}>
        Войти через Discord
      </button>
    </main>
  );
}
