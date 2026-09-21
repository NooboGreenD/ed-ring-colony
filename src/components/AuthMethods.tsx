'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { startOAuthAction } from '@/app/login/actions';
import { OAUTH_PROVIDERS, isOAuthProvider, oauthErrorMessage, canUnlinkOAuthIdentity, type OAuthProvider } from '@/lib/oauthProviders';

export function OAuthNotice() {
  const [notice, setNotice] = useState('');
  const [isError, setIsError] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const provider = url.searchParams.get('provider');
    const error = url.searchParams.get('oauth_error') || url.searchParams.get('error');
    if (error) {
      setNotice(oauthErrorMessage(error, isOAuthProvider(provider) ? provider : undefined));
      setIsError(true);
    } else if (url.searchParams.get('oauth') === 'linked' && isOAuthProvider(provider)) {
      setNotice(`${OAUTH_PROVIDERS[provider].label} привязан к этому аккаунту.`);
    }
    for (const key of ['oauth_error', 'error', 'oauth', 'provider']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  return notice ? <p role={isError ? 'alert' : 'status'} className={isError ? 'auth-error' : undefined}>{notice}</p> : null;
}

/** Login and account linking deliberately share one provider registry/PKCE flow. */
export default function AuthMethods({ user, onChanged, disabled = false }: {
  user?: User; onChanged?: () => void | Promise<void>; disabled?: boolean;
}) {
  const [enabled, setEnabled] = useState<OAuthProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/auth/providers', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('providers');
        const data = await response.json();
        if (!Array.isArray(data.providers)) throw new Error('providers');
        if (active) { setEnabled(data.providers.filter(isOAuthProvider)); setLoaded(true); }
      })
      .catch(() => { if (active) setMessage('Не удалось загрузить способы входа. Обновите страницу.'); });
    return () => { active = false; };
  }, []);

  const linked = (user?.identities ?? []).map(identity => identity.provider).filter(isOAuthProvider);
  const providers = [...new Set([...enabled, ...linked])];
  const start = async (provider: OAuthProvider) => {
    setBusy(true); setMessage('');
    try {
      const result = await startOAuthAction(provider, user ? 'link' : 'login');
      if (result.error || !result.url) setMessage(result.error || 'Не получен адрес авторизации.');
      else { window.location.assign(result.url); return; }
    } catch { setMessage('Ошибка соединения. Повторите попытку.'); }
    setBusy(false);
  };

  const unlink = async (provider: OAuthProvider) => {
    if (!window.confirm(`Отвязать ${OAUTH_PROVIDERS[provider].label}? Убедитесь, что можете войти другим способом.`)) return;
    setBusy(true); setMessage('');
    try {
      // Re-read identities: the account may have changed in another tab.
      const { data: { user: current }, error: userError } = await supabase.auth.getUser();
      if (userError || !current || current.id !== user?.id) throw new Error('account_mismatch');
      const identity = current.identities?.find(item => item.provider === provider);
      if (!identity) throw new Error('Identity not found');
      if (!canUnlinkOAuthIdentity(current, provider, enabled)) throw new Error('last_identity');
      const { error } = await supabase.auth.unlinkIdentity(identity);
      if (error) throw error;
      setMessage(`${OAUTH_PROVIDERS[provider].label} отвязан.`);
      await onChanged?.();
    } catch (error) {
      setMessage(oauthErrorMessage(error instanceof Error ? error.message : '', provider));
    } finally { setBusy(false); }
  };

  return <div>
    <OAuthNotice />
    {user && <p style={{ color: '#9ca3af', fontSize: 13 }}>
      Все привязанные способы ведут в одно досье. Перед отвязкой настройте пароль
      или другой способ входа. Для пароля воспользуйтесь восстановлением по почте. Frontier CAPI ниже — источник игровых данных, а не вход на сайт.
    </p>}
    {!loaded && !message && <p>Загрузка способов входа…</p>}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {providers.map(provider => <div key={provider}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {OAUTH_PROVIDERS[provider].label}: {linked.includes(provider) ? 'привязан' : 'не привязан'}
        </p>}
        <button type="button" className={linked.includes(provider) ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded}
          onClick={() => linked.includes(provider) ? void unlink(provider) : void start(provider)}>
          {linked.includes(provider) ? 'Отвязать' : user ? 'Привязать' : 'Войти через'} {OAUTH_PROVIDERS[provider].label}
        </button>
      </div>)}
    </div>
    {message && <p role="status" className="auth-error">{message}</p>}
  </div>;
}
