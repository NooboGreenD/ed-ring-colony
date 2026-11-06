'use client';

/**
 * «Проект в Raven Colonial» — создание проекта постройки плана прямо с сайта.
 *
 * Тот же проект можно создать и в Colonial Helper: связь хранится в плане
 * (`ravenBuildId`), поэтому обе стороны не создают вторую запись.
 * RCC-ключ пользователя хранится на сервере в зашифрованном виде; в браузере
 * после сохранения виден только маскированный вид.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { installationName } from '@/lib/architect/catalogue';
import type { ArchitectBody, ArchitectPlan, PlannedSite } from '@/lib/architect/types';
import { getInstallation } from '@/lib/architect/planner';
import { cardStyle, errorText, inputStyle, mutedText, primaryButton, rowStyle, sectionTitle, ghostButton } from '@/components/Architect/panelStyles';
import { useI18n } from '@/lib/i18n/I18nContext';

interface KeyState {
  connected: boolean;
  mask: string | null;
  cmdrName: string | null;
}

interface RavenCreatePanelProps {
  system: string;
  plan: ArchitectPlan;
  bodiesByName: Map<string, ArchitectBody>;
  /** Постройка создана в Raven: вызывающий ставит ей `ravenBuildId` в плане. */
  onLinked: (siteId: string, buildId: string) => void;
}

const NO_KEY: KeyState = { connected: false, mask: null, cmdrName: null };

export default function RavenCreatePanel({ system, plan, bodiesByName, onLinked }: RavenCreatePanelProps) {
  const { t, locale } = useI18n();
  const [keyState, setKeyState] = useState<KeyState>(NO_KEY);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');

  const unlinked = useMemo(() => plan.sites.filter((site) => !site.ravenBuildId), [plan.sites]);
  const [siteId, setSiteId] = useState('');
  const [marketId, setMarketId] = useState('');
  const [systemAddress, setSystemAddress] = useState('');
  const [buildName, setBuildName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const site: PlannedSite | undefined = unlinked.find((item) => item.id === siteId) ?? unlinked[0];

  useEffect(() => {
    let cancelled = false;
    fetch('/api/architect/raven-key', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: KeyState) => { if (!cancelled && typeof data.connected === 'boolean') setKeyState(data); })
      .catch(() => { /* без сети панель остаётся «не подключено» */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (site && !buildName) {
      const installation = getInstallation(site.installationId);
      setBuildName(installation ? `${installationName(installation, locale)} — ${site.bodyName}` : site.bodyName);
    }
  }, [site, buildName]);

  const saveKey = useCallback(async () => {
    setKeyBusy(true);
    setKeyError('');
    try {
      const res = await fetch('/api/architect/raven-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('rvcp.error', { status: res.status }));
      setKeyState({ connected: true, mask: data.mask, cmdrName: data.cmdrName });
      setKeyInput('');
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }, [keyInput, t]);

  const removeKey = useCallback(async () => {
    setKeyBusy(true);
    setKeyError('');
    try {
      await fetch('/api/architect/raven-key', { method: 'DELETE' });
      setKeyState(NO_KEY);
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }, [t]);

  const create = useCallback(async () => {
    if (!site) return;
    setBusy(true);
    setError('');
    setMessage('');
    const body = bodiesByName.get(site.bodyName);
    try {
      const res = await fetch('/api/architect/raven-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system,
          site,
          body: body ? { name: body.name, bodyId: body.bodyId } : null,
          marketId: Number(marketId),
          systemAddress: Number(systemAddress),
          buildName,
          architectName: plan.architect,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('rvcp.error', { status: res.status }));
      onLinked(site.id, String(data.buildId));
      setMessage(t('rvcp.created', { id: data.buildId })
        + (data.linkError ? t('rvcp.linkFailed', { error: data.linkError }) : ''));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [site, bodiesByName, marketId, systemAddress, buildName, system, plan.architect, onLinked, t]);

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('rvcp.title')}</h3>
      </div>

      {!keyState.connected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <div style={mutedText}>
            {t('rvcp.keyIntro')}
          </div>
          <input
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder={t('rvcp.keyPlaceholder')}
            style={inputStyle}
            autoComplete="off"
          />
          <button type="button" onClick={saveKey} disabled={keyBusy || keyInput.trim().length < 8} style={primaryButton}>
            {keyBusy ? t('rvcp.checking') : t('rvcp.saveKey')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={{ ...mutedText, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>{t('rvcp.keyLine', { mask: keyState.mask ?? '' })}{keyState.cmdrName ? t('rvcp.cmdrSuffix', { name: keyState.cmdrName }) : ''}</span>
            <button type="button" onClick={removeKey} disabled={keyBusy} style={ghostButton}>{t('rvcp.removeKey')}</button>
          </div>

          {unlinked.length === 0 ? (
            <div style={mutedText}>{t('rvcp.allLinked')}</div>
          ) : (
            <>
              <label style={mutedText}>
                {t('rvcp.build')}
                <select
                  value={site?.id ?? ''}
                  onChange={(event) => { setSiteId(event.target.value); setBuildName(''); }}
                  style={{ ...inputStyle, marginLeft: 8 }}
                >
                  {unlinked.map((item) => (
                    <option key={item.id} value={item.id}>
                      {installationName(getInstallation(item.installationId), locale) || item.installationId} · {item.bodyName}
                    </option>
                  ))}
                </select>
              </label>
              <label style={mutedText}>
                {t('rvcp.marketId')}
                <input value={marketId} onChange={(e) => setMarketId(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <label style={mutedText}>
                {t('rvcp.systemAddress')}
                <input value={systemAddress} onChange={(e) => setSystemAddress(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <label style={mutedText}>
                {t('rvcp.projectName')}
                <input value={buildName} onChange={(e) => setBuildName(e.target.value)} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <button
                type="button"
                onClick={create}
                disabled={busy || !site || !marketId || !systemAddress || !buildName.trim()}
                style={primaryButton}
              >
                {busy ? t('rvcp.creating') : t('rvcp.create')}
              </button>
              <div style={mutedText}>
                {t('rvcp.hint')}
              </div>
            </>
          )}
        </div>
      )}

      {keyError && <div style={{ ...errorText, marginTop: 6 }}>{keyError}</div>}
      {error && <div style={{ ...errorText, marginTop: 6 }}>{error}</div>}
      {message && <div style={{ ...mutedText, marginTop: 6 }}>{message}</div>}
    </section>
  );
}
