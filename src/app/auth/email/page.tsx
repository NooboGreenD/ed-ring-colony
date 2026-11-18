'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

type LinkData = { token_hash: string; type: 'signup' | 'recovery' };
export default function EmailConfirmationPage() {
  const { t } = useI18n();
  const initialized = useRef(false);
  const [link, setLink] = useState<LinkData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 5xx/429 — не приговор ссылке: сервис не ответил, и кнопку надо оставить.
  // Раньше здесь был один путь — «попробуйте ещё раз», но кнопки уже не было.
  const [retryable, setRetryable] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = new URL(window.location.href);
    // New mail templates put the proof in the fragment: it never reaches HTTP logs.
    const fragment = new URLSearchParams(url.hash.slice(1));
    const params = fragment.has('token_hash') ? fragment : url.searchParams;
    const token = params.get('token_hash');
    const type = params.get('type');
    // Письмо, отправленное встроенным шаблоном GoTrue, приносит `token`
    // (и `type=signup`, и `redirect_to`). Проверить его нашим POST-ом нельзя:
    // это не TokenHash, а одноразовый токен самого эндпоинта Supabase —
    // именно поэтому такая ссылка ведёт на API и отвечает 404. Но понять, что
    // перед нами старый формат, можно, и это лучше общего «ссылка неверного
    // формата»: пилоту нужно просто запросить новое письмо.
    const legacyToken = !token && Boolean(params.get('token'));
    // Drop the bearer secret from browser history immediately. There is no
    // verification/automatic sign-in until the visitor explicitly presses a button.
    window.history.replaceState(window.history.state, '', '/auth/email');
    if (token && /^[a-zA-Z0-9_-]{32,256}$/.test(token) && (type === 'signup' || type === 'recovery')) {
      setLink({ token_hash: token, type });
    } else setError(legacyToken ? t('ae.oldLink') : t('ae.badLink'));
  }, []);
  const confirm = async () => {
    if (!link) return;
    setBusy(true); setError(''); setRetryable(false);
    try {
      const response = await fetch('/api/auth/email/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || t('ae.confirmFailed'));
        // Ссылка одноразовая, поэтому кнопку оставляем только когда сервер сам
        // сказал, что её не тронул: иначе второе нажатие гарантированно упрётся
        // в «ссылка уже использована».
        setRetryable(response.status >= 500 || response.status === 429);
        return;
      }
      // Fixed destinations only; never follow a caller-provided `next` URL.
      window.location.assign(link.type === 'recovery' ? '/reset-password' : '/account');
    } catch { setError(t('ae.connectionRetry')); setRetryable(true); }
    finally { setBusy(false); }
  };
  return <main className="card auth-card">
    <div className="kicker">ED Ring Colony</div>
    <h1>{link?.type === 'recovery' ? t('ae.recoveryTitle') : t('ae.confirmEmailTitle')}</h1>
    <p>{t('ae.note')}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {link && (!error || retryable) && <button disabled={busy} onClick={() => void confirm()}>{busy ? t('ae.checking') : link.type === 'recovery' ? t('ae.toNewPassword') : t('ae.confirmMine')}</button>}
    <p className="auth-switch"><Link href="/resend-confirmation">{t('ae.repeatConfirm')}</Link> · <Link href="/forgot-password">{t('ef.recoverTitle')}</Link></p>
  </main>;
}
