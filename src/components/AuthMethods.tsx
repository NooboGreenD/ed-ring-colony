'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { startOAuthAction, startVkAuthAction, startYandexAuthAction } from '@/app/login/actions';
import { OAUTH_PROVIDERS, isOAuthProvider, oauthErrorMessage, canUnlinkOAuthIdentity, type OAuthProvider } from '@/lib/oauthProviders';
import { VK_LABEL, VK_PROVIDER, vkErrorMessage } from '@/lib/vkShared';
import { YANDEX_LABEL, YANDEX_PROVIDER, yandexErrorMessage } from '@/lib/yandexShared';

export function OAuthNotice() {
  const [notice, setNotice] = useState('');
  const [isError, setIsError] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const provider = url.searchParams.get('provider');
    const error = url.searchParams.get('oauth_error') || url.searchParams.get('error');
    if (error) {
      setNotice(provider === VK_PROVIDER ? vkErrorMessage(error)
        : provider === YANDEX_PROVIDER ? yandexErrorMessage(error)
        : oauthErrorMessage(error, isOAuthProvider(provider) ? provider : undefined));
      setIsError(true);
    } else if (url.searchParams.get('oauth') === 'linked' && provider === VK_PROVIDER) {
      setNotice(`${VK_LABEL} привязан к этому аккаунту.`);
    } else if (url.searchParams.get('oauth') === 'linked' && provider === YANDEX_PROVIDER) {
      setNotice(`${YANDEX_LABEL} привязан к этому аккаунту.`);
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
  const [vkEnabled, setVkEnabled] = useState(false);
  const [vk, setVk] = useState<{ linked: boolean; name: string | null; canUnlink: boolean } | null>(null);
  const loadVk = async () => {
    if (!user) return;
    try {
      const response = await fetch('/api/auth/vk', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      setVk({ linked: Boolean(data.linked), name: data.vk?.name ?? null, canUnlink: Boolean(data.canUnlink) });
    } catch { /* status stays unknown; the button still works */ }
  };
  const [yandexEnabled, setYandexEnabled] = useState(false);
  const [yandex, setYandex] = useState<{ linked: boolean; name: string | null; canUnlink: boolean } | null>(null);
  const loadYandex = async () => {
    if (!user) return;
    try {
      const response = await fetch('/api/auth/yandex', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      setYandex({ linked: Boolean(data.linked), name: data.yandex?.name ?? null, canUnlink: Boolean(data.canUnlink) });
    } catch { /* status stays unknown; the button still works */ }
  };
  useEffect(() => {
    let active = true;
    fetch('/api/auth/providers', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('providers');
        const data = await response.json();
        if (!Array.isArray(data.providers)) throw new Error('providers');
        if (active) {
          setEnabled(data.providers.filter(isOAuthProvider));
          setVkEnabled(Boolean(data.vk));
          setYandexEnabled(Boolean(data.yandex));
          setLoaded(true);
        }
      })
      .catch(() => { if (active) setMessage('Не удалось загрузить способы входа. Обновите страницу.'); });
    void loadVk();
    void loadYandex();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const startVk = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await startVkAuthAction(user ? 'link' : 'login');
      if (result.error || !result.url) setMessage(result.error || 'Не получен адрес авторизации.');
      else { window.location.assign(result.url); return; }
    } catch { setMessage('Ошибка соединения. Повторите попытку.'); }
    setBusy(false);
  };
  const unlinkVk = async () => {
    if (!window.confirm(`Отвязать ${VK_LABEL}? Убедитесь, что можете войти другим способом.`)) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/auth/vk', { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'vk_failed');
      setMessage(`${VK_LABEL} отвязан.`);
      await loadVk();
      await onChanged?.();
    } catch (error) {
      setMessage(vkErrorMessage(error instanceof Error ? error.message : ''));
    } finally { setBusy(false); }
  };

  const startYandex = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await startYandexAuthAction(user ? 'link' : 'login');
      if (result.error || !result.url) setMessage(result.error || 'Не получен адрес авторизации.');
      else { window.location.assign(result.url); return; }
    } catch { setMessage('Ошибка соединения. Повторите попытку.'); }
    setBusy(false);
  };
  const unlinkYandex = async () => {
    if (!window.confirm(`Отвязать ${YANDEX_LABEL}? Убедитесь, что можете войти другим способом.`)) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/auth/yandex', { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'yandex_failed');
      setMessage(`${YANDEX_LABEL} отвязан.`);
      await loadYandex();
      await onChanged?.();
    } catch (error) {
      setMessage(yandexErrorMessage(error instanceof Error ? error.message : ''));
    } finally { setBusy(false); }
  };

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
      {(vkEnabled || vk?.linked) && <div key={VK_PROVIDER}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {VK_LABEL}: {vk?.linked ? `привязан${vk.name ? ` (${vk.name})` : ''}` : 'не привязан'}
        </p>}
        <button type="button" className={vk?.linked ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded || (vk?.linked && !vk.canUnlink)}
          title={vk?.linked && !vk.canUnlink ? vkErrorMessage('last_identity') : undefined}
          onClick={() => vk?.linked ? void unlinkVk() : void startVk()}>
          {vk?.linked ? 'Отвязать' : user ? 'Привязать' : 'Войти через'} {VK_LABEL}
        </button>
      </div>}
      {(yandexEnabled || yandex?.linked) && <div key={YANDEX_PROVIDER}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {YANDEX_LABEL}: {yandex?.linked ? `привязан${yandex.name ? ` (${yandex.name})` : ''}` : 'не привязан'}
        </p>}
        <button type="button" className={yandex?.linked ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded || (yandex?.linked && !yandex.canUnlink)}
          title={yandex?.linked && !yandex.canUnlink ? yandexErrorMessage('last_identity') : undefined}
          onClick={() => yandex?.linked ? void unlinkYandex() : void startYandex()}>
          {yandex?.linked ? 'Отвязать' : user ? 'Привязать' : 'Войти через'} {YANDEX_LABEL}
        </button>
      </div>}
    </div>
    {message && <p role="status" className="auth-error">{message}</p>}
  </div>;
}
