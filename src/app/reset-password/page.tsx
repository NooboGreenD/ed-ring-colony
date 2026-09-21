'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { passwordError } from '@/lib/passwordPolicy';

export default function ResetPasswordPage() {
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
        else setError(result.error || 'Запросите новую ссылку восстановления.');
      }
    }).catch(() => { if (active) setError('Не удалось проверить сессию. Обновите страницу.'); });
    return () => { active = false; };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    const problem = passwordError(password);
    if (problem) { setError(problem); return; }
    if (password !== confirm) { setError('Пароли не совпадают.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || 'Не удалось изменить пароль.'); return; }
      setPassword(''); setConfirm(''); setWarning(result.warning || ''); setDone(true);
    } catch { setError('Ошибка соединения. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <h1>Новый пароль</h1>
    {done ? <div role="status">
      <p>Пароль изменён. Войдите с новым паролем. Для Uploader создайте новый API-токен.</p>
      {warning && <p role="alert" className="auth-error">{warning}</p>}
      <a href="/login">Войти</a>
    </div> : <>
      <p>Ссылка даёт 10 минут на смену пароля. Прежние сеансы обновления и токены Uploader будут отозваны; история и досье сохранятся. Привязанные Discord/Google/GitHub остаются — проверьте их в аккаунте, если подозреваете чужой доступ.</p>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {ready && <form className="auth-form" onSubmit={submit}>
        <label>Пароль (не менее 12 символов)<input type="password" autoComplete="new-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>Повтор пароля<input type="password" autoComplete="new-password" required value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
        <button disabled={busy}>{busy ? 'Сохранение…' : 'Изменить пароль и отозвать токены'}</button>
      </form>}
      <p><Link href="/forgot-password">Запросить новую ссылку</Link></p>
    </>}
  </main>;
}
