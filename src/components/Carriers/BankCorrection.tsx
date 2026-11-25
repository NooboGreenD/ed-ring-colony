'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch, supabase } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';
import { BANK_GOODS, validBankInventory, type BankCorrectionHistory, type BankInventoryItem } from '@/lib/bankCorrection';

type Row = { commodity: string; qty: string };
function localTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

/** Permission is fetched from the server, never inferred from a public card. */
export default function BankCorrection({ carrierId, callsign, onCorrected }: {
  carrierId: string; callsign: string | null; onCorrected: () => void;
}) {
  const { t, locale } = useI18n();
  const [allowed, setAllowed] = useState(false);
  const [history, setHistory] = useState<BankCorrectionHistory[]>([]);
  const [stage, setStage] = useState<'closed' | 'edit' | 'review'>('closed');
  const [rows, setRows] = useState<Row[]>([]);
  const [observed, setObserved] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timeBusy, setTimeBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const posting = useRef(false);
  const clockOffset = useRef(0);
  const aborts = useRef(new Set<AbortController>());
  const endpoint = `/api/carriers/${encodeURIComponent(carrierId)}/bank/correction`;
  const label = useCallback((commodity: string, fallback: string) => {
    if (['drones', 'tritium', 'thargoidtitandrivecomponent'].includes(commodity)) return t(`bc.${commodity}`);
    const key = `commodity.${commodity}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  }, [t]);
  const goods = useMemo(() => [...new Map(BANK_GOODS.map(good => [good.commodity,
    { ...good, label: label(good.commodity, good.name) }])).values()].sort((a, b) => a.label.localeCompare(b.label, locale)), [label, locale]);
  const inventory: BankInventoryItem[] = rows.map(row => ({ commodity: row.commodity,
    qty: /^\d+$/.test(row.qty) ? Number(row.qty) : NaN,
    name_localised: goods.find(good => good.commodity === row.commodity)?.label ?? row.commodity,
  }));
  const total = inventory.reduce((sum, item) => sum + (Number.isFinite(item.qty) ? item.qty : 0), 0);

  const load = useCallback(async (useTime = false) => {
    const version = generation.current;
    const controller = new AbortController(); aborts.current.add(controller);
    if (useTime) setTimeBusy(true);
    try {
      const response = await authFetch(endpoint, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (version !== generation.current) return;
      if ([401, 403, 404].includes(response.status) || (response.ok && data.canCorrect !== true)) {
        setAllowed(false); setHistory([]); setStage('closed'); setRows([]); setReason(''); setObserved(''); setConfirmation(''); setComplete(false);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(t('bc.unavailable'));
      if (Number.isFinite(Date.parse(data.serverNow))) clockOffset.current = Date.parse(data.serverNow) - Date.now();
      setAllowed(true); setHistory(Array.isArray(data.history) ? data.history : []);
      if (useTime) setObserved(localTime(data.serverNow));
    } catch {
      if (version === generation.current && !controller.signal.aborted) setError(t('bc.unavailable'));
    } finally {
      aborts.current.delete(controller);
      if (version === generation.current) setTimeBusy(false);
    }
  }, [endpoint, t]);

  useEffect(() => {
    void load();
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      if (!['SIGNED_OUT', 'SIGNED_IN', 'USER_UPDATED'].includes(event)) return;
      generation.current++;
      aborts.current.forEach(controller => controller.abort());
      posting.current = false;
      setAllowed(false); setHistory([]); setStage('closed'); setRows([]); setReason(''); setObserved(''); setConfirmation(''); setComplete(false); setError(''); setNotice(''); setBusy(false); setTimeBusy(false);
      if (event !== 'SIGNED_OUT') queueMicrotask(() => { if (active) void load(); });
    });
    return () => {
      active = false; generation.current++;
      aborts.current.forEach(controller => controller.abort());
      subscription.unsubscribe();
    };
  }, [load]);

  const review = () => {
    setError(''); setNotice('');
    if (!complete || !callsign || confirmation.trim().toUpperCase() !== callsign.toUpperCase()
      || !observed || !Number.isFinite(new Date(observed).getTime()) || new Date(observed).getTime() > Date.now() + clockOffset.current + 60000
      || reason.trim().length < 10 || reason.trim().length > 1000 || !validBankInventory(inventory)) {
      setError(t('bc.invalid')); return;
    }
    setStage('review');
  };
  const save = async () => {
    if (posting.current) return;
    posting.current = true; setBusy(true); setError('');
    const version = generation.current;
    const controller = new AbortController(); aborts.current.add(controller);
    try {
      const response = await authFetch(endpoint, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callsign: confirmation.trim(),
          observedAt: new Date(observed).toISOString(), reason: reason.trim(), items: inventory, confirmComplete: complete,
        }) });
      const data = await response.json();
      if (version !== generation.current) return;
      if (!response.ok || !data.ok) {
        if (response.status === 401 || response.status === 403) { setAllowed(false); setStage('closed'); setHistory([]); setRows([]); setReason(''); setObserved(''); setConfirmation(''); setComplete(false); }
        throw new Error(data.error || t('bc.unavailable'));
      }
      setStage('closed'); setRows([]); setObserved(''); setReason(''); setConfirmation(''); setComplete(false);
      setNotice(t('bc.saved'));
      void load(); onCorrected();
    } catch (failure) {
      if (version === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('bc.unavailable'));
    } finally {
      aborts.current.delete(controller);
      if (version === generation.current) { posting.current = false; setBusy(false); }
    }
  };

  if (!allowed) return error ? <p role="alert">{error} <button type="button" onClick={() => { setError(''); void load(); }}>{t('cj.refresh')}</button></p> : null;
  return <section className="bank-correction" aria-label={t('bc.title')}>
    {stage === 'closed' && <button type="button" className="btn btn-secondary" onClick={() => { setError(''); setNotice(''); setStage('edit'); }}>{t('bc.title')}</button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {stage !== 'closed' && <div className="bank-correction-form">
      <h3>{t('bc.title')} · {callsign}</h3>
      <p role="note">{t('bc.warning')}</p>
      {stage === 'edit' ? <>
        <label>{t('bc.observed')}<input type="datetime-local" step="1" value={observed} disabled={busy || timeBusy} onChange={event => setObserved(event.target.value)} /></label>
        <button type="button" disabled={timeBusy || busy} onClick={() => void load(true)}>{t('bc.now')}</button>
        {observed && Number.isFinite(new Date(observed).getTime()) && <small>UTC: {new Date(observed).toISOString()}</small>}
        <div className="bank-correction-rows">{rows.map((row, index) => <div className="bank-correction-row" key={index}>
          <select aria-label={t('bc.good')} value={row.commodity} onChange={event => setRows(rows.map((value, i) => i === index ? { ...value, commodity: event.target.value } : value))}>
            <option value="">{t('bc.good')}</option>{goods.map(good => <option key={good.commodity} value={good.commodity}>{good.label}</option>)}
          </select>
          <input type="number" aria-label={t('bc.quantity')} min="0" max="60000" step="1" value={row.qty} onChange={event => setRows(rows.map((value, i) => i === index ? { ...value, qty: event.target.value } : value))} />
          <button type="button" aria-label={t('bc.remove')} onClick={() => setRows(rows.filter((_, i) => i !== index))}>×</button>
        </div>)}</div>
        <button type="button" disabled={rows.length >= 512} onClick={() => setRows([...rows, { commodity: '', qty: '' }])}>{t('bc.add')}</button>
        <label>{t('bc.reason')}<textarea value={reason} minLength={10} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>
        <label>{t('bc.callsign')}<input value={confirmation} maxLength={20} placeholder={callsign ?? ''} onChange={event => setConfirmation(event.target.value)} /></label>
        <label className="bank-correction-confirm"><input type="checkbox" checked={complete} onChange={event => setComplete(event.target.checked)} />{t('bc.complete')}</label>
        <button type="button" className="btn btn-primary" disabled={timeBusy} onClick={review}>{t('bc.review')}</button>
      </> : <>
        <p>{t('bc.preview', { total: total.toLocaleString(locale), count: inventory.length })}</p>
        <ul>{inventory.map(item => <li key={item.commodity}>{item.name_localised}: {item.qty.toLocaleString(locale)}</li>)}</ul>
        {!inventory.length && <strong>{t('bc.empty')}</strong>}
        <p>{t('bc.observed')}: {new Date(observed).toLocaleString(locale)} · UTC {new Date(observed).toISOString()}</p>
        <p>{reason}</p>
        <button type="button" disabled={busy} onClick={() => setStage('edit')}>{t('bc.back')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{t(busy ? 'bc.saving' : 'bc.save')}</button>
      </>}
      <button type="button" disabled={busy || timeBusy} onClick={() => { setStage('closed'); setError(''); }}>{t('bc.cancel')}</button>
    </div>}
    {!!history.length && <details><summary>{t('bc.history')}</summary><ol>{history.map(item => <li key={item.id}>
      <time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString(locale)}</time> · {item.author} · {item.total.toLocaleString(locale)} t
      <p>{item.reason}</p><small>{t('bc.recorded')}: {new Date(item.recordedAt).toLocaleString(locale)}</small>
    </li>)}</ol></details>}
  </section>;
}
