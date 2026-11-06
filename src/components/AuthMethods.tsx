'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { startOAuthAction, startVkAuthAction, startYandexAuthAction } from '@/app/login/actions';
import { OAUTH_PROVIDERS, isOAuthProvider, oauthErrorMessage, canUnlinkOAuthIdentity, type OAuthProvider } from '@/lib/oauthProviders';
import { VK_LABEL, VK_PROVIDER, vkErrorMessage } from '@/lib/vkShared';
import { YANDEX_LABEL, YANDEX_PROVIDER, yandexErrorMessage } from '@/lib/yandexShared';
import { useI18n } from '@/lib/i18n/I18nContext';

export function OAuthNotice() {
  const [notice, setNotice] = useState('');
  const [isError, setIsError] = useState(false);
  const { t } = useI18n();
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
      setNotice(t('amth.linkedTo', { provider: VK_LABEL }));
    } else if (url.searchParams.get('oauth') === 'linked' && provider === YANDEX_PROVIDER) {
      setNotice(t('amth.linkedTo', { provider: YANDEX_LABEL }));
    } else if (url.searchParams.get('oauth') === 'linked' && isOAuthProvider(provider)) {
      setNotice(t('amth.linkedTo', { provider: OAUTH_PROVIDERS[provider].label }));
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
  const { t } = useI18n();
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
      .catch(() => { if (active) setMessage(t('amth.loadFailed')); });
    void loadVk();
    void loadYandex();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const startVk = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await startVkAuthAction(user ? 'link' : 'login');
      if (result.error || !result.url) setMessage(result.error || t('amth.noAuthUrl'));
      else { window.location.assign(result.url); return; }
    } catch { setMessage(t('amth.connectionError')); }
    setBusy(false);
  };
  const unlinkVk = async () => {
    if (!window.confirm(t('amth.confirmUnlink', { provider: VK_LABEL }))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/auth/vk', { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'vk_failed');
      setMessage(t('amth.unlinked', { provider: VK_LABEL }));
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
      if (result.error || !result.url) setMessage(result.error || t('amth.noAuthUrl'));
      else { window.location.assign(result.url); return; }
    } catch { setMessage(t('amth.connectionError')); }
    setBusy(false);
  };
  const unlinkYandex = async () => {
    if (!window.confirm(t('amth.confirmUnlink', { provider: YANDEX_LABEL }))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/auth/yandex', { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'yandex_failed');
      setMessage(t('amth.unlinked', { provider: YANDEX_LABEL }));
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
      if (result.error || !result.url) setMessage(result.error || t('amth.noAuthUrl'));
      else { window.location.assign(result.url); return; }
    } catch { setMessage(t('amth.connectionError')); }
    setBusy(false);
  };

  const unlink = async (provider: OAuthProvider) => {
    if (!window.confirm(t('amth.confirmUnlink', { provider: OAUTH_PROVIDERS[provider].label }))) return;
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
      setMessage(t('amth.unlinked', { provider: OAUTH_PROVIDERS[provider].label }));
      await onChanged?.();
    } catch (error) {
      setMessage(oauthErrorMessage(error instanceof Error ? error.message : '', provider));
    } finally { setBusy(false); }
  };

  return <div>
    <OAuthNotice />
    {user && <p style={{ color: '#9ca3af', fontSize: 13 }}>
      {t('amth.intro')}
    </p>}
    {!loaded && !message && <p>{t('amth.loading')}</p>}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {providers.map(provider => <div key={provider}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {OAUTH_PROVIDERS[provider].label}: {linked.includes(provider) ? t('amth.linked') : t('amth.notLinked')}
        </p>}
        <button type="button" className={linked.includes(provider) ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded}
          onClick={() => linked.includes(provider) ? void unlink(provider) : void start(provider)}>
          {linked.includes(provider) ? t('amth.unlink') : user ? t('amth.link') : t('amth.loginVia')} {OAUTH_PROVIDERS[provider].label}
        </button>
      </div>)}
      {(vkEnabled || vk?.linked) && <div key={VK_PROVIDER}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {VK_LABEL}: {vk?.linked ? t('amth.linked') + (vk.name ? ` (${vk.name})` : '') : t('amth.notLinked')}
        </p>}
        <button type="button" className={vk?.linked ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded || (vk?.linked && !vk.canUnlink)}
          title={vk?.linked && !vk.canUnlink ? vkErrorMessage('last_identity') : undefined}
          onClick={() => vk?.linked ? void unlinkVk() : void startVk()}>
          {vk?.linked ? t('amth.unlink') : user ? t('amth.link') : t('amth.loginVia')} {VK_LABEL}
        </button>
      </div>}
      {(yandexEnabled || yandex?.linked) && <div key={YANDEX_PROVIDER}>
        {user && <p style={{ fontSize: 12, marginBottom: 6 }}>
          {YANDEX_LABEL}: {yandex?.linked ? t('amth.linked') + (yandex.name ? ` (${yandex.name})` : '') : t('amth.notLinked')}
        </p>}
        <button type="button" className={yandex?.linked ? 'btn danger-btn' : 'btn btn-cyan'}
          disabled={disabled || busy || !loaded || (yandex?.linked && !yandex.canUnlink)}
          title={yandex?.linked && !yandex.canUnlink ? yandexErrorMessage('last_identity') : undefined}
          onClick={() => yandex?.linked ? void unlinkYandex() : void startYandex()}>
          {yandex?.linked ? t('amth.unlink') : user ? t('amth.link') : t('amth.loginVia')} {YANDEX_LABEL}
        </button>
      </div>}
    </div>
    {message && <p role="status" className="auth-error">{message}</p>}
  </div>;
}
