'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconRefresh, IconSearch, IconStar, IconX } from '@/components/Icons';
import { toast } from '@/components/ui/Toaster';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  localCarrierWatch,
  mergeCarrierWatches,
  normalizeCarrierWatch,
  readLocalCarrierWatches,
  watchFor,
  writeLocalCarrierWatches,
  type CarrierWatch,
} from '@/lib/carrierDirectory';
import type { MapCarrier } from '@/lib/carrierMap';
import {
  buildJumpBoard,
  buildJumpWatchRows,
  matchesJumpQuery,
  type JumpBoardRow,
  type JumpPlanState,
} from '@/lib/carrierJumps';
import { systemPageHref } from '@/lib/systemIdentity';

/** Как часто страница сама обновляет заказы: прыжок живёт минутами, не часами. */
const REFRESH_MS = 60_000;
/** Подпись плана для «Мои подписки». */
const PLAN_KEY: Record<JumpPlanState, string> = {
  none: 'cj.planNone',
  same: 'cj.planSame',
  changed: 'cj.planChanged',
  arrived: 'cj.planArrived',
  gone: 'cj.planGone',
};

interface JumpFeed {
  carriers?: MapCarrier[];
  viewer?: { signedIn?: boolean };
  generatedAt?: string;
  total?: number;
  truncated?: boolean;
  error?: string;
}

/** Снимок прыжка в записи пилота: по нему видно, изменился ли план. */
function hasJumpSnapshot(watch: CarrierWatch | null | undefined): boolean {
  return Boolean(watch && (watch.jumpSystem || watch.jumpDepartureAt));
}

function timeOf(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

/** Абсолютное время вылета: дата и часы, без секунд. */
function departureLabel(value: string | null, locale: string): string {
  const ms = timeOf(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «через 2 ч», «12 мин назад» — чтобы не пересчитывать время в уме. */
function relativeLabel(value: string | null, now: number, locale: string): string {
  const ms = timeOf(value);
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit: Intl.RelativeTimeFormatUnit = abs < 3_600_000 ? 'minute' : abs < 172_800_000 ? 'hour' : 'day';
  const step = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(diff / step), unit);
  } catch {
    return '';
  }
}

function distanceLabel(value: number | null, locale: string): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type WatchJump = { system: string | null; departureAt: string | null };

interface PersistInput {
  carrierId: string;
  callsign: string | null;
  name: string | null;
  system: string | null;
  favorite: boolean;
  note: string | null;
  /** `undefined` — снимок плана не трогаем; `null` в полях — снимаем подписку. */
  jump?: WatchJump;
}

/**
 * Таблица «Авианосцы перед прыжком»: что заказано, когда и куда.
 *
 * Данные — только из учёта сайта (`/api/carriers/jumps`): заказ прыжка
 * приходит из Colonial Helper и загрузки журналов, EDDN его не передаёт.
 * Личные подписки — тот же серверный список, что у избранного Атласа, а у
 * гостя — localStorage: подписка не должна требовать входа.
 */
export function CarrierJumpBoard() {
  const { t, locale } = useI18n();
  const [carriers, setCarriers] = useState<MapCarrier[]>([]);
  const [watches, setWatches] = useState<CarrierWatch[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [onlyWatched, setOnlyWatched] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  /* ── личный список: сервер, а у гостя — браузер ── */
  const loadWatches = useCallback(async () => {
    try {
      const response = await fetch('/api/atlas/carriers/watch', { cache: 'no-store' });
      if (response.status === 401) {
        setSignedIn(false);
        setWatches(readLocalCarrierWatches());
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json() as { watches?: CarrierWatch[] };
      if (!alive.current) return;
      // Локальные записи не теряем: они могли появиться до входа.
      setSignedIn(true);
      setWatches(mergeCarrierWatches(payload.watches ?? [], readLocalCarrierWatches()));
    } catch {
      // Сеть недоступна — работаем как гость, без ошибки на весь раздел.
      if (!alive.current) return;
      setSignedIn(false);
      setWatches(readLocalCarrierWatches());
    }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const response = await fetch('/api/carriers/jumps', { cache: 'no-store' });
      const payload = await response.json() as JumpFeed;
      if (!response.ok) throw new Error(payload.error || String(response.status));
      if (!alive.current) return;
      const stamp = payload.generatedAt ? timeOf(payload.generatedAt) : NaN;
      setCarriers(Array.isArray(payload.carriers) ? payload.carriers : []);
      setTotal(Number(payload.total ?? payload.carriers?.length ?? 0));
      setTruncated(Boolean(payload.truncated));
      setGeneratedAt(payload.generatedAt ?? new Date().toISOString());
      setNow(Number.isFinite(stamp) ? stamp : Date.now());
      if (payload.viewer?.signedIn != null) {
        setSignedIn((current) => current ?? Boolean(payload.viewer?.signedIn));
      }
      setError('');
      setStatus('ready');
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadWatches();
    void loadFeed();
  }, [loadFeed, loadWatches]);

  // Прыжок — событие на минуты: без обновления таблица устареет незаметно.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void loadFeed();
    }, REFRESH_MS);
    const ticker = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(ticker);
    };
  }, [loadFeed]);

  const reload = useCallback(() => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    void loadWatches();
    void loadFeed();
  }, [loadFeed, loadWatches]);

  const localOnly = signedIn === false;

  /**
   * Сохранить личную запись: у вошедшего — на сервере, у гостя — в браузере.
   * `jump` управляет снимком плана: без него обычное избранное Атласа
   * сохраняется как раньше, а подписка не затирается пустыми полями.
   */
  const persist = useCallback(async (input: PersistInput): Promise<{ ok: boolean; watch: CarrierWatch | null }> => {
    const normalized = normalizeCarrierWatch(input);
    if (!normalized.ok) {
      toast(t('cj.saveFailed'), 'error');
      return { ok: false, watch: null };
    }
    const value = normalized.value;
    const key = value.carrierId;
    const subscribed = Boolean(input.jump?.system);
    // Пустая запись (не в избранном, без заметки и без подписки) не нужна.
    const remove = !value.favorite && !value.note && !subscribed;
    const seenAt = subscribed ? new Date().toISOString() : null;
    const localValue = {
      ...value,
      jumpSystem: input.jump ? input.jump.system : null,
      jumpDepartureAt: input.jump ? input.jump.departureAt : null,
      jumpSeenAt: seenAt,
    };

    setSaving(key);
    const fallbackLocal = () => {
      const next = remove
        ? watches.filter((watch) => watch.carrierId !== key)
        : mergeCarrierWatches([localCarrierWatch(localValue)], watches.filter((watch) => watch.carrierId !== key));
      writeLocalCarrierWatches(next);
      setWatches(next);
      return next.find((watch) => watch.carrierId === key) ?? null;
    };

    try {
      if (localOnly) return { ok: true, watch: fallbackLocal() };
      const response = remove
        ? await fetch(`/api/atlas/carriers/watch?carrierId=${encodeURIComponent(key)}`, { method: 'DELETE' })
        : await fetch('/api/atlas/carriers/watch', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            carrierId: key,
            callsign: value.callsign,
            name: value.name,
            system: value.system,
            favorite: value.favorite,
            note: value.note,
            ...(input.jump
              ? { jumpSystem: input.jump.system, jumpDepartureAt: input.jump.departureAt }
              : {}),
          }),
        });
      if (response.status === 401) {
        // Сессия истекла посреди работы: дальше — локально, без потери выбора.
        setSignedIn(false);
        return { ok: true, watch: fallbackLocal() };
      }
      if (!response.ok) throw new Error(String(response.status));
      if (remove) {
        setWatches((current) => current.filter((watch) => watch.carrierId !== key));
        return { ok: true, watch: null };
      }
      const body = await response.json() as { watch?: CarrierWatch };
      const saved = body.watch ?? localCarrierWatch(localValue);
      setWatches((current) => mergeCarrierWatches([saved], current.filter((watch) => watch.carrierId !== key)));
      return { ok: true, watch: saved };
    } catch {
      toast(t('cj.saveFailed'), 'error');
      return { ok: false, watch: null };
    } finally {
      if (alive.current) setSaving(null);
    }
  }, [localOnly, t, watches]);

  /** Подписка и отписка из таблицы: снимок плана — «куда» и «когда» сейчас. */
  const toggleWatch = useCallback(async (row: JumpBoardRow) => {
    const current = watchFor(watches, row.id);
    const subscribed = hasJumpSnapshot(current);
    const result = await persist({
      carrierId: row.id,
      callsign: row.callsign,
      name: row.carrier.name,
      system: row.from,
      // Подписка — не избранное Атласа: не добавляем носитель в чужой список
      // без спроса. Если он уже там, флаг сохраняем.
      favorite: current?.favorite ?? false,
      note: current?.note ?? null,
      jump: subscribed
        ? { system: null, departureAt: null }
        : { system: row.to, departureAt: row.departureAt },
    });
    if (!result.ok) return;
    toast(subscribed ? t('cj.unsubscribedToast') : t('cj.subscribedToast'), 'success');
  }, [persist, t, watches]);

  /** Снять подписку из «Моих подписок»: носителя может уже не быть в таблице. */
  const clearWatch = useCallback(async (watch: CarrierWatch) => {
    const result = await persist({
      carrierId: watch.carrierId,
      callsign: watch.callsign,
      name: watch.name,
      system: watch.system,
      favorite: watch.favorite,
      note: watch.note,
      jump: { system: null, departureAt: null },
    });
    if (result.ok) toast(t('cj.unsubscribedToast'), 'success');
  }, [persist, t]);

  const board = useMemo(() => buildJumpBoard(carriers, { now, watches }), [carriers, now, watches]);
  const visible = useMemo(
    () => board.filter((row) => matchesJumpQuery(row, query) && (!onlyWatched || hasJumpSnapshot(row.watch))),
    [board, onlyWatched, query],
  );
  const myWatches = useMemo(() => buildJumpWatchRows(watches, board), [board, watches]);
  const updated = generatedAt ? departureLabel(generatedAt, locale) : '';

  return (
    <div className="cj-board">
      <div className="cj-toolbar">
        <div className="cj-search">
          <IconSearch size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('cj.searchPlaceholder')}
            aria-label={t('cj.searchAria')}
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="cj-icon-btn"
              onClick={() => setQuery('')}
              aria-label={t('cj.clearSearch')}
              title={t('cj.clearSearch')}
            >
              <IconX size={14} />
            </button>
          ) : null}
        </div>
        <label className="cj-toggle">
          <input
            type="checkbox"
            checked={onlyWatched}
            onChange={(event) => setOnlyWatched(event.target.checked)}
          />
          <span>{t('cj.onlyWatched')}</span>
        </label>
        <button
          type="button"
          className="cj-btn"
          onClick={reload}
          disabled={status === 'loading'}
          title={t('cj.refreshTitle')}
        >
          <IconRefresh size={14} />
          {t('cj.refresh')}
        </button>
      </div>

      <p className="cj-meta">
        <span>{t('cj.found', { total })}</span>
        <span>{t('cj.watchCount', { count: myWatches.length })}</span>
        {updated ? <span>{t('cj.updated', { date: updated })}</span> : null}
        {truncated ? <span className="cj-warn">{t('cj.truncated', { shown: board.length })}</span> : null}
      </p>

      {status === 'error' ? (
        <div className="cj-state-block" role="alert">
          <b>{t('cj.loadFailed')}</b>
          <span>{error || t('cj.loadFailed')}</span>
          <button type="button" className="cj-btn" onClick={reload}>{t('cj.retry')}</button>
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="cj-state-block">
          <b>{t('cj.loading')}</b>
          <span>{t('cj.loadingDetail')}</span>
        </div>
      ) : null}

      {status === 'ready' && board.length === 0 ? (
        <div className="cj-state-block">
          <b>{t('cj.emptyTitle')}</b>
          <span>{t('cj.emptyHint')}</span>
          <span className="cj-dim">{t('cj.emptySource')}</span>
        </div>
      ) : null}

      {status === 'ready' && board.length > 0 ? (
        visible.length ? (
          <div className="cj-scroll">
            <table className="cj-table" aria-label={t('cj.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('cj.colCarrier')}</th>
                  <th scope="col">{t('cj.colRoute')}</th>
                  <th scope="col" className="cj-num">{t('cj.colDistance')}</th>
                  <th scope="col">{t('cj.colDeparture')}</th>
                  <th scope="col">{t('cj.colState')}</th>
                  <th scope="col">{t('cj.colWatch')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const subscribed = hasJumpSnapshot(row.watch);
                  const relative = relativeLabel(row.departureAt, now, locale);
                  const absolute = departureLabel(row.departureAt, locale);
                  return (
                    <tr key={row.id}>
                      <td data-label={t('cj.colCarrier')}>
                        <span className="cj-callsign">{row.callsign || t('cj.noCallsign')}</span>
                        {row.carrier.name ? <span className="cj-name">{row.carrier.name}</span> : null}
                        {row.tone === 'decommission' ? <span className="cj-chip">{t('acw.decommission')}</span> : null}
                      </td>
                      <td data-label={t('cj.colRoute')}>
                        <span className="cj-route">
                          <span className="cj-system">{row.from}</span>
                          <span className="cj-arrow" aria-hidden="true">→</span>
                          <Link
                            className="cj-system cj-target"
                            href={systemPageHref(row.to)}
                            title={t('cj.openSystem', { system: row.to })}
                          >
                            {row.to}
                          </Link>
                        </span>
                      </td>
                      <td data-label={t('cj.colDistance')} className="cj-num">
                        {distanceLabel(row.distanceLy, locale)}
                      </td>
                      <td data-label={t('cj.colDeparture')}>
                        {absolute ? <span className="cj-time">{absolute}</span> : (
                          <span className="cj-dim">{t('cj.departureUnknown')}</span>
                        )}
                        {relative ? <span className="cj-relative">{relative}</span> : null}
                      </td>
                      <td data-label={t('cj.colState')}>
                        <span className={`cj-pill ${row.state}`}>
                          {row.state === 'jumping' ? t('cj.stateJumping') : t('cj.stateScheduled')}
                        </span>
                      </td>
                      <td data-label={t('cj.colWatch')}>
                        <button
                          type="button"
                          className={`cj-sub${subscribed ? ' on' : ''}`}
                          onClick={() => void toggleWatch(row)}
                          disabled={saving === row.id}
                          aria-pressed={subscribed}
                          title={subscribed ? t('cj.subscribedTitle') : t('cj.subscribeTitle')}
                        >
                          <IconStar size={13} />
                          {subscribed ? t('cj.unsubscribe') : t('cj.subscribe')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cj-empty-inline">
            {query.trim() ? t('cj.notFound', { query }) : t('cj.noneWatched')}
          </p>
        )
      ) : null}

      <section className="cj-watch">
        <div className="cj-watch-head">
          <h2>{t('cj.watchTitle')}</h2>
          <span className="cj-dim">{localOnly ? t('cj.guestHint') : t('cj.personalHint')}</span>
        </div>
        {myWatches.length === 0 ? (
          <p className="cj-empty-inline">
            <b>{t('cj.watchEmpty')}</b>
            {' — '}
            {t('cj.watchEmptyHint')}
          </p>
        ) : (
          <ul className="cj-watch-list">
            {myWatches.map(({ watch, live, plan }) => {
              const label = watch.name || watch.callsign || watch.carrierId;
              const target = live?.to ?? plan.to ?? plan.from;
              const at = live?.departureAt ?? plan.toAt ?? plan.at;
              const atLabel = departureLabel(at, locale);
              const was = plan.from && plan.state !== 'same' ? plan.from : null;
              const seen = watch.jumpSeenAt ? departureLabel(watch.jumpSeenAt, locale) : '';
              return (
                <li key={watch.carrierId} className="cj-watch-item">
                  <div className="cj-watch-main">
                    <span className="cj-watch-name">{label}</span>
                    {target ? (
                      <span className="cj-watch-route">
                        {t('cj.planNow', {
                          system: target,
                          time: atLabel || t('cj.departureUnknown'),
                        })}
                      </span>
                    ) : null}
                    {was ? (
                      <span className="cj-watch-was">
                        {t('cj.planWas', {
                          system: was,
                          time: departureLabel(plan.at, locale) || t('cj.departureUnknown'),
                        })}
                      </span>
                    ) : null}
                    {seen ? <span className="cj-watch-seen">{t('cj.snapshotAt', { date: seen })}</span> : null}
                  </div>
                  <div className="cj-watch-side">
                    <span className={`cj-plan ${plan.state}`}>{t(PLAN_KEY[plan.state])}</span>
                    <button
                      type="button"
                      className="cj-icon-btn"
                      onClick={() => void clearWatch(watch)}
                      disabled={saving === watch.carrierId}
                      aria-label={t('cj.unsubscribe')}
                      title={t('cj.unsubscribe')}
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="cj-footnote">{t('cj.footnote')}</p>
    </div>
  );
}

export default CarrierJumpBoard;
