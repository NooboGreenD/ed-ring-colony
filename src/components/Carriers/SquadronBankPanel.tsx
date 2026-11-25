'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, supabase } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { SquadronBankCarrier } from '@/lib/squadronBank';
import { CarrierBankPanel } from './CarrierBankPanel';
import BankCorrection from './BankCorrection';

type State = {
  squadronId: number;
  status: 'loading' | 'ready' | 'denied' | 'error';
  carriers: SquadronBankCarrier[];
};

/** Mounted only on the active bank tab; never polls in the background. */
export default function SquadronBankPanel({ squadronId }: { squadronId: number }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<State>({ squadronId, status: 'loading', carriers: [] });
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (background = false) => {
    const current = ++sequence.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    if (!background) setState({ squadronId, status: 'loading', carriers: [] });
    try {
      const response = await authFetch(`/api/squadrons/${squadronId}/bank`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (current !== sequence.current) return;
      if (response.status === 401 || response.status === 403) {
        setState({ squadronId, status: 'denied', carriers: [] });
        return;
      }
      const data = await response.json();
      if (current !== sequence.current) return;
      if (!response.ok || !data.ok || !Array.isArray(data.carriers)) throw new Error('bank unavailable');
      // Also fail closed on a public/personal carrier response.
      const carriers = (data.carriers as SquadronBankCarrier[])
        .filter(carrier => carrier.type === 'SquadronCarrier' && carrier.relation === 'squadron');
      setState({ squadronId, status: 'ready', carriers });
    } catch {
      if (current === sequence.current && !controller.signal.aborted) {
        setState({ squadronId, status: 'error', carriers: [] });
      }
    }
  }, [squadronId]);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60_000);
    let alive = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      // Clear private state synchronously. Defer authFetch outside the auth callback.
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        ++sequence.current;
        pending.current?.abort();
        setState({ squadronId, status: event === 'SIGNED_OUT' ? 'denied' : 'loading', carriers: [] });
        if (event !== 'SIGNED_OUT') queueMicrotask(() => { if (alive) void load(); });
      }
    });
    return () => {
      alive = false;
      ++sequence.current;
      pending.current?.abort();
      clearInterval(refresh);
      subscription.unsubscribe();
    };
  }, [load, squadronId]);

  const current = state.squadronId === squadronId ? state : { squadronId, status: 'loading', carriers: [] } as State;
  const nf = new Intl.NumberFormat(locale);
  const total = current.carriers.reduce((sum, carrier) => sum + (carrier.cargo?.trackedTotal ?? 0), 0);
  return (
    <section aria-label={t('sq.tabBank')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: '#e67e22', fontSize: 20 }}>{t('sq.tabBank')}</h2>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={current.status === 'loading'}>
          {t('cj.refresh')}
        </button>
      </div>
      {current.status === 'loading' && <p role="status">{t('common.loading')}</p>}
      {current.status === 'denied' && <p role="status">{t('sq.bankMembersOnly')}</p>}
      {current.status === 'error' && <p role="alert">{t('fc.bankUnavailable')}</p>}
      {current.status === 'ready' && (current.carriers.length === 0 ? (
        <div className="card" style={{ padding: 20 }}><p>{t('sq.bankNoCarrier')}</p></div>
      ) : (
        <>
          <p style={{ color: '#9ca3af', marginBottom: 16 }}>{t('fc.trackedTotal', { count: nf.format(total) })}</p>
          <div style={{ display: 'grid', gap: 16 }}>
            {current.carriers.map(carrier => (
              <article className="card" key={carrier.carrierId} style={{ padding: 20, minWidth: 0 }}>
                <h3 style={{ marginTop: 0 }}>
                  <Link href={`/carriers/${encodeURIComponent(carrier.carrierId)}`}>
                    {carrier.name || carrier.callsign || carrier.carrierId}
                  </Link>
                  {carrier.callsign && carrier.name && <small style={{ color: '#9ca3af', marginLeft: 10 }}>{carrier.callsign}</small>}
                </h3>
                {carrier.cargo ? <CarrierBankPanel carrier={carrier} /> : <p>{t('fc.cargoNotTracked')}</p>}
                <BankCorrection carrierId={carrier.carrierId} callsign={carrier.callsign} onCorrected={() => void load(true)} />
              </article>
            ))}
          </div>
        </>
      ))}
    </section>
  );
}
