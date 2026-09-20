'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

type LinkData = { token_hash: string; type: 'signup' | 'recovery' };
export default function EmailConfirmationPage() {
  const initialized = useRef(false);
  const [link, setLink] = useState<LinkData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = new URL(window.location.href);
    // New mail templates put the proof in the fragment: it never reaches HTTP logs.
    const fragment = new URLSearchParams(url.hash.slice(1));
    const params = fragment.has('token_hash') ? fragment : url.searchParams;
    const token = params.get('token_hash');
    const type = params.get('type');
    // Drop the bearer secret from browser history immediately. There is no
    // verification/automatic sign-in until the visitor explicitly presses a button.
    window.history.replaceState(window.history.state, '', '/auth/email');
    if (token && /^[a-zA-Z0-9_-]{32,256}$/.test(token) && (type === 'signup' || type === 'recovery')) {
      setLink({ token_hash: token, type });
    } else setError('Ссылка неверного или старого формата. Запросите новое письмо.');
  }, []);
  const confirm = async () => {
    if (!link) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/email/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || 'Не удалось подтвердить ссылку.'); return; }
      // Fixed destinations only; never follow a caller-provided `next` URL.
      window.location.assign(link.type === 'recovery' ? '/reset-password' : '/account');
    } catch { setError('Ошибка соединения. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <div className="kicker">ED Ring Colony</div>
    <h1>{link?.type === 'recovery' ? 'Восстановление доступа' : 'Подтверждение почты'}</h1>
    <p>Продолжайте, только если вы запрашивали это письмо. Открытие ссылки само по себе не изменяет аккаунт.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {link && <button disabled={busy} onClick={() => void confirm()}>{busy ? 'Проверка…' : link.type === 'recovery' ? 'Перейти к новому паролю' : 'Подтвердить мой email'}</button>}
    <p className="auth-switch"><Link href="/resend-confirmation">Повторить подтверждение</Link> · <Link href="/forgot-password">Восстановить пароль</Link></p>
  </main>;
}
