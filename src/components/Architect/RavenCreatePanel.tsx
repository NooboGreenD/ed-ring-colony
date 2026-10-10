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
import type { ArchitectBody, ArchitectPlan, PlannedSite } from '@/lib/architect/types';
import { getInstallation } from '@/lib/architect/planner';
import { cardStyle, errorText, inputStyle, mutedText, primaryButton, rowStyle, sectionTitle, ghostButton } from '@/components/Architect/panelStyles';

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
      setBuildName(installation ? `${installation.nameRu} — ${site.bodyName}` : site.bodyName);
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
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      setKeyState({ connected: true, mask: data.mask, cmdrName: data.cmdrName });
      setKeyInput('');
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }, [keyInput]);

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
  }, []);

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
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      onLinked(site.id, String(data.buildId));
      setMessage(`Проект создан в Raven Colonial (buildId ${data.buildId}).`
        + (data.linkError ? ` Привязка к командиру не прошла: ${data.linkError}` : ''));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [site, bodiesByName, marketId, systemAddress, buildName, system, plan.architect, onLinked]);

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>Проект в Raven Colonial</h3>
      </div>

      {!keyState.connected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <div style={mutedText}>
            Чтобы создавать проекты с сайта, сохраните RCC-ключ (Raven Colonial → настройки).
            Ключ хранится на сервере в зашифрованном виде и в браузер не возвращается.
          </div>
          <input
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder="RCC-ключ"
            style={inputStyle}
            autoComplete="off"
          />
          <button type="button" onClick={saveKey} disabled={keyBusy || keyInput.trim().length < 8} style={primaryButton}>
            {keyBusy ? 'Проверяю…' : 'Сохранить ключ'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={{ ...mutedText, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>Ключ: {keyState.mask}{keyState.cmdrName ? ` · командир ${keyState.cmdrName}` : ''}</span>
            <button type="button" onClick={removeKey} disabled={keyBusy} style={ghostButton}>Удалить ключ</button>
          </div>

          {unlinked.length === 0 ? (
            <div style={mutedText}>Все постройки плана уже связаны с проектами Raven.</div>
          ) : (
            <>
              <label style={mutedText}>
                Постройка
                <select
                  value={site?.id ?? ''}
                  onChange={(event) => { setSiteId(event.target.value); setBuildName(''); }}
                  style={{ ...inputStyle, marginLeft: 8 }}
                >
                  {unlinked.map((item) => (
                    <option key={item.id} value={item.id}>
                      {getInstallation(item.installationId)?.nameRu ?? item.installationId} · {item.bodyName}
                    </option>
                  ))}
                </select>
              </label>
              <label style={mutedText}>
                MarketID стройплощадки (из игры)
                <input value={marketId} onChange={(e) => setMarketId(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <label style={mutedText}>
                SystemAddress системы
                <input value={systemAddress} onChange={(e) => setSystemAddress(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <label style={mutedText}>
                Название проекта
                <input value={buildName} onChange={(e) => setBuildName(e.target.value)} style={{ ...inputStyle, marginLeft: 8 }} />
              </label>
              <button
                type="button"
                onClick={create}
                disabled={busy || !site || !marketId || !systemAddress || !buildName.trim()}
                style={primaryButton}
              >
                {busy ? 'Создаю…' : 'Создать проект в Raven'}
              </button>
              <div style={mutedText}>
                Raven требует MarketID и SystemAddress: их знает журнал игры (стройплощадка) и адрес системы.
                После создания постройка связывается с проектом и не дублируется при синхронизациях.
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
