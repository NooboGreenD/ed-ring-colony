'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconCalendar, IconHistory, IconPlus, IconTrash, IconX } from '@/components/Icons';
import { toast } from '@/components/ui/Toaster';
import { useI18n } from '@/lib/i18n/I18nContext';
import { systemPageHref } from '@/lib/systemIdentity';
import {
  buildMonthGrid,
  compareSchedules,
  entriesForDay,
  entryDay,
  groupEntriesByDay,
  monthKey,
  nextEntryAt,
  scheduleHref,
  shiftMonth,
  type JumpSchedule,
  type JumpScheduleEntry,
  type JumpScheduleVisibility,
} from '@/lib/carrierJumpSchedule';

/**
 * Вкладка «Расписание» на `/carriers/jumps`.
 *
 * Заказы прыжка живут минуты, планы — дни: здесь пилот ведёт свой календарь
 * носителей. Слева список расписаний (свои и публичные), справа календарь
 * месяца: в ячейке дня — счётчик прыжков, под сеткой — сами прыжки выбранного
 * дня, ниже форма ручного плана.
 *
 * Приватность: `private` видит только владелец, `public` читается по ссылке
 * без входа, но правит его всегда владелец. Ссылку на публичное расписание
 * даёт кнопка «скопировать»: это `/carriers/jumps?tab=calendar&schedule=<id>`.
 */
export interface CarrierJumpCalendarProps {
  /** Ссылка на расписание из адресной строки (`?schedule=`). */
  initialScheduleId?: string | null;
  /** Открыть прыжок в расписании: значение из строки живой таблицы. */
  prefill?: { carrierId: string; callsign: string | null; name: string | null; from: string; to: string; departureAt: string } | null;
  /** Сообщить странице, что прыжок принят в расписание (сбросить `prefill`). */
  onPrefillUsed?: () => void;
  /** Сменилось расписание в адресе — страница обновляет `?schedule=`. */
  onSelectSchedule?: (scheduleId: string | null) => void;
}

interface ScheduleListResponse {
  schedules?: JumpSchedule[];
  viewer?: { signedIn?: boolean };
  error?: string;
}

interface ScheduleResponse {
  schedule?: JumpSchedule;
  entries?: JumpScheduleEntry[];
  error?: string;
}

/** `datetime-local` → ISO: браузер отдаёт местное время без зоны. */
function localInputToIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** ISO → значение для `datetime-local` (в местной зоне браузера). */
function isoToLocalInput(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeLabel(value: string | null | undefined, locale: string): string {
  const ms = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function dateLabel(value: string | null | undefined, locale: string, options: Intl.DateTimeFormatOptions = {}): string {
  const ms = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(locale, options);
}

function monthTitle(month: string, locale: string): string {
  return dateLabel(`${month}T00:00:00.000Z`, locale, { month: 'long', year: 'numeric' });
}

export function CarrierJumpCalendar({
  initialScheduleId = null,
  prefill = null,
  onPrefillUsed,
  onSelectSchedule,
}: CarrierJumpCalendarProps) {
  const { t, locale } = useI18n();
  const [schedules, setSchedules] = useState<JumpSchedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialScheduleId);
  const [detail, setDetail] = useState<{ schedule: JumpSchedule; entries: JumpScheduleEntry[] } | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Форма нового расписания.
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newVisibility, setNewVisibility] = useState<JumpScheduleVisibility>('private');
  // Календарь.
  const [month, setMonth] = useState(() => monthKey());
  const [day, setDay] = useState<string | null>(null);
  // Форма прыжка.
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ callsign: '', from: '', to: '', when: '', note: '' });
  // Живые заказы: «взять из таблицы» на вкладке расписания. Загружаются здесь,
  // а не приходят сверху: вкладки живут независимо и не должны тянуть данные
  // друг друга через состояние страницы.
  const [liveRows, setLiveRows] = useState<Array<{ id: string; label: string; callsign: string | null; from: string; to: string; departureAt: string | null }>>([]);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const publishSelection = useCallback((id: string | null) => {
    setSelectedId(id);
    onSelectSchedule?.(id);
  }, [onSelectSchedule]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/carriers/jumps', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as { carriers?: Array<{ id: string; callsign: string | null; name: string | null; system: string; jump?: { system: string; departureAt: string | null } | null }> };
        if (cancelled || !alive.current) return;
        setLiveRows((payload.carriers ?? [])
          .filter((carrier) => carrier.jump)
          .map((carrier) => ({
            id: carrier.id,
            label: carrier.name || carrier.callsign || carrier.id,
            callsign: carrier.callsign,
            from: carrier.system,
            to: carrier.jump?.system ?? '',
            departureAt: carrier.jump?.departureAt ?? null,
          })));
      } catch {
        // Список заказов — подсказка, а не данные расписания: молча живём без него.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSchedules = useCallback(async () => {
    try {
      const response = await fetch('/api/carriers/jumps/schedules', { cache: 'no-store' });
      const payload = await response.json() as ScheduleListResponse;
      if (!response.ok) throw new Error(payload.error || String(response.status));
      if (!alive.current) return;
      const list = [...(payload.schedules ?? [])].sort(compareSchedules);
      setSchedules(list);
      setSignedIn(Boolean(payload.viewer?.signedIn));
      setStatus('ready');
      setError('');
      // Выбор из адреса мог устареть: расписание удалили или оно чужое и закрыто.
      setSelectedId((current) => (current && !list.some((item) => item.id === current) ? null : current));
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    }
  }, []);

  const loadSchedule = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/carriers/jumps/schedules/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const payload = await response.json() as ScheduleResponse;
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          if (alive.current) {
            setDetail(null);
            toast(t('api.jumpScheduleForbidden'), 'error');
            publishSelection(null);
          }
          return;
        }
        throw new Error(payload.error || String(response.status));
      }
      if (!alive.current) return;
      if (payload.schedule) {
        setDetail({ schedule: payload.schedule, entries: payload.entries ?? [] });
      }
    } catch (cause) {
      if (!alive.current) return;
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }, [publishSelection, t]);

  useEffect(() => { void loadSchedules(); }, [loadSchedules]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadSchedule(selectedId);
  }, [loadSchedule, selectedId]);

  // Прыжок, присланный из живой таблицы: открываем форму с готовыми полями.
  // Без выбранного своего расписания добавлять некуда — ждём выбора.
  useEffect(() => {
    if (!prefill || !detail?.schedule.mine) return;
    setAdding(true);
    setForm({
      callsign: prefill.callsign ?? '',
      from: prefill.from,
      to: prefill.to,
      when: isoToLocalInput(prefill.departureAt),
      note: '',
    });
    setDay(entryDay(prefill.departureAt));
    setMonth(monthKey(prefill.departureAt));
    onPrefillUsed?.();
  }, [detail?.schedule.mine, onPrefillUsed, prefill]);

  const mine = detail?.schedule.mine ?? false;
  const entries = detail?.entries ?? [];
  const grid = useMemo(() => buildMonthGrid(month, entries), [month, entries]);
  const byDay = useMemo(() => groupEntriesByDay(entries), [entries]);
  const dayEntries = useMemo(() => (day ? entriesForDay(entries, day) : []), [day, entries]);
  const nextAt = useMemo(() => nextEntryAt(entries), [entries]);
  // Порядок задаёт `compareSchedules` (свои сверху, затем по ближайшему вылету).
  const visibleSchedules = useMemo(() => [...schedules].sort(compareSchedules), [schedules]);

  /** Создать расписание и сразу его выбрать. */
  const createSchedule = useCallback(async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const response = await fetch('/api/carriers/jumps/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, note: newNote, visibility: newVisibility }),
      });
      const payload = await response.json() as { schedule?: JumpSchedule; error?: string };
      if (!response.ok || !payload.schedule) throw new Error(payload.error || String(response.status));
      setNewTitle('');
      setNewNote('');
      setNewVisibility('private');
      toast(t('cjc.created'), 'success');
      await loadSchedules();
      publishSelection(payload.schedule.id);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('cjc.createFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [loadSchedules, newNote, newTitle, newVisibility, publishSelection, t]);

  /** Сменить видимость: приватное ↔ публичное. Правит только владелец. */
  const toggleVisibility = useCallback(async () => {
    if (!detail?.schedule.mine) return;
    const next: JumpScheduleVisibility = detail.schedule.visibility === 'public' ? 'private' : 'public';
    setSaving(true);
    try {
      const response = await fetch(`/api/carriers/jumps/schedules/${encodeURIComponent(detail.schedule.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      });
      const payload = await response.json() as { schedule?: JumpSchedule; error?: string };
      if (!response.ok || !payload.schedule) throw new Error(payload.error || String(response.status));
      setDetail((current) => (current ? { ...current, schedule: payload.schedule as JumpSchedule } : current));
      toast(t('cjc.visibilityChanged'), 'success');
      await loadSchedules();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('cjc.createFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [detail?.schedule.id, detail?.schedule.mine, detail?.schedule.visibility, loadSchedules, t]);

  const copyLink = useCallback(async (scheduleId: string) => {
    if (typeof window === 'undefined') return;
    const link = `${window.location.origin}${scheduleHref(scheduleId)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast(t('cjc.linkCopied'), 'success');
    } catch {
      // Буфер обмена может быть закрыт: показываем ссылку в подсказке.
      toast(link, 'info');
    }
  }, [t]);

  const removeSchedule = useCallback(async () => {
    if (!detail?.schedule.mine) return;
    if (typeof window !== 'undefined' && !window.confirm(t('cjc.deleteConfirm'))) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/carriers/jumps/schedules/${encodeURIComponent(detail.schedule.id)}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || String(response.status));
      }
      toast(t('cjc.deleted'), 'success');
      setDetail(null);
      publishSelection(null);
      await loadSchedules();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('cjc.deleteFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [detail?.schedule.id, detail?.schedule.mine, loadSchedules, publishSelection, t]);

  /** Добавить прыжок вручную: системы, время и, если знаем, позывной. */
  const addEntry = useCallback(async () => {
    if (!detail?.schedule.mine) return;
    const departureAt = localInputToIso(form.when);
    if (!form.from.trim() || !form.to.trim() || !departureAt) {
      toast(t('cjc.addFailed'), 'error');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/carriers/jumps/schedules/${encodeURIComponent(detail.schedule.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callsign: form.callsign,
          from: form.from,
          to: form.to,
          departureAt,
          note: form.note,
        }),
      });
      const payload = await response.json() as { entry?: JumpScheduleEntry; error?: string; duplicate?: boolean };
      if (response.status === 409 || payload.duplicate) {
        toast(t('cjc.duplicate'), 'error');
        return;
      }
      if (!response.ok || !payload.entry) throw new Error(payload.error || String(response.status));
      setDetail((current) => (current
        ? { ...current, entries: [...current.entries, payload.entry as JumpScheduleEntry].sort((left, right) => left.departureAt.localeCompare(right.departureAt)) }
        : current));
      setForm({ callsign: '', from: '', to: '', when: '', note: '' });
      setAdding(false);
      toast(t('cjc.added'), 'success');
      await loadSchedules();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('cjc.addFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [detail?.schedule.id, detail?.schedule.mine, form, loadSchedules, t]);

  const removeEntry = useCallback(async (entryId: string) => {
    if (!detail?.schedule.mine) return;
    setSaving(true);
    try {
      const url = `/api/carriers/jumps/schedules/${encodeURIComponent(detail.schedule.id)}?entry=${encodeURIComponent(entryId)}`;
      const response = await fetch(url, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || String(response.status));
      }
      setDetail((current) => (current
        ? { ...current, entries: current.entries.filter((entry) => entry.id !== entryId) }
        : current));
      toast(t('cjc.removed'), 'success');
      await loadSchedules();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('cjc.removeFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [detail?.schedule.id, detail?.schedule.mine, loadSchedules, t]);

  /* ── разметка ── */

  if (status === 'error') {
    return (
      <div className="cj-state-block" role="alert">
        <b>{t('cjc.loadFailed')}</b>
        <span>{error}</span>
        <button type="button" className="cj-btn" onClick={() => { setStatus('loading'); void loadSchedules(); }}>
          {t('cjc.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="cjc-layout">
      <aside className="cjc-side">
        <div className="cjc-side-head">
          <h2>{t('cjc.title')}</h2>
          <span className="cj-dim">{t('cjc.intro')}</span>
        </div>

        {signedIn ? (
          <form
            className="cjc-new"
            onSubmit={(event) => { event.preventDefault(); void createSchedule(); }}
          >
            <b>{t('cjc.newTitle')}</b>
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder={t('cjc.namePlaceholder')}
              aria-label={t('cjc.newTitle')}
              maxLength={80}
            />
            <textarea
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
              placeholder={t('cjc.notePlaceholder')}
              aria-label={t('cjc.notePlaceholder')}
              rows={2}
              maxLength={500}
            />
            <div className="cjc-new-row">
              <select
                value={newVisibility}
                onChange={(event) => setNewVisibility(event.target.value === 'public' ? 'public' : 'private')}
                aria-label={t('cjc.visibility')}
              >
                <option value="private">{t('cjc.visibilityPrivate')}</option>
                <option value="public">{t('cjc.visibilityPublic')}</option>
              </select>
              <button type="submit" className="cj-btn" disabled={saving || !newTitle.trim()}>
                <IconPlus size={14} />
                {t('cjc.create')}
              </button>
            </div>
          </form>
        ) : (
          <p className="cj-empty-inline">{t('cjc.guestHint')}</p>
        )}

        {visibleSchedules.length === 0 ? (
          <p className="cj-empty-inline">
            <b>{t('cjc.empty')}</b>
            {' — '}
            {t('cjc.emptyHint')}
          </p>
        ) : (
          <ul className="cjc-list">
            {visibleSchedules.map((schedule) => (
              <li key={schedule.id}>
                <button
                  type="button"
                  className={`cjc-item${selectedId === schedule.id ? ' active' : ''}`}
                  onClick={() => publishSelection(schedule.id)}
                  aria-pressed={selectedId === schedule.id}
                >
                  <span className="cjc-item-title">
                    {schedule.title}
                    {schedule.mine ? <span className="cjc-badge mine">{t('cjc.mine')}</span> : null}
                    <span className={`cjc-badge ${schedule.visibility}`}>
                      {schedule.visibility === 'public' ? t('cjc.publicTag') : t('cjc.privateTag')}
                    </span>
                  </span>
                  <span className="cjc-item-meta">
                    <IconCalendar size={11} />
                    {t('cjc.entryCount', { count: schedule.entryCount })}
                    {schedule.ownerName && !schedule.mine ? <span>· {schedule.ownerName}</span> : null}
                    {schedule.nextEntryAt ? (
                      <span>
                        · {t('cjc.next', {
                          date: dateLabel(schedule.nextEntryAt, locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
                        })}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="cjc-main">
        {!detail ? (
          <p className="cj-empty-inline">{prefill ? t('cjc.addEntryHint') : t('cjc.noSchedule')}</p>
        ) : (
          <>
            <header className="cjc-head">
              <div>
                <h2>{detail.schedule.title}</h2>
                {detail.schedule.note ? <p className="cj-dim">{detail.schedule.note}</p> : null}
                <p className="cj-dim">
                  {detail.schedule.mine ? t('cjc.privateHint') : t('cjc.externalHint')}
                  {detail.schedule.mine && detail.schedule.visibility === 'public' ? ` ${t('cjc.publicLinkHint')}` : ''}
                </p>
              </div>
              <div className="cjc-head-actions">
                {mine ? (
                  <button type="button" className="cj-btn" onClick={() => void toggleVisibility()} disabled={saving}>
                    {detail.schedule.visibility === 'public' ? t('cjc.makePrivate') : t('cjc.makePublic')}
                  </button>
                ) : null}
                {detail.schedule.visibility === 'public' ? (
                  <button type="button" className="cj-btn" onClick={() => void copyLink(detail.schedule.id)}>
                    {t('cjc.copyLink')}
                  </button>
                ) : null}
                {mine ? (
                  <button
                    type="button"
                    className="cj-icon-btn cjc-danger"
                    onClick={() => void removeSchedule()}
                    disabled={saving}
                    aria-label={t('cjc.deleteTitle')}
                    title={t('cjc.deleteTitle')}
                  >
                    <IconTrash size={14} />
                  </button>
                ) : null}
              </div>
            </header>

            {nextAt ? (
              <p className="cjc-next">
                <IconHistory size={12} />
                {t('cjc.next', { date: dateLabel(nextAt, locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })}
              </p>
            ) : null}

            <div className="cjc-month">
              <div className="cjc-month-head">
                <button
                  type="button"
                  className="cj-btn"
                  onClick={() => setMonth(shiftMonth(month, -1))}
                  aria-label={t('cjc.monthPrev')}
                >
                  ‹
                </button>
                <b>{monthTitle(month, locale)}</b>
                <button
                  type="button"
                  className="cj-btn"
                  onClick={() => setMonth(shiftMonth(month, 1))}
                  aria-label={t('cjc.monthNext')}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="cj-btn"
                  onClick={() => { setMonth(monthKey()); setDay(new Date().toISOString().slice(0, 10)); }}
                >
                  {t('cjc.today')}
                </button>
              </div>

              <div className="cjc-grid" role="grid" aria-label={monthTitle(month, locale)}>
                {grid.weeks.map((week) => week.map((cell) => (
                  <button
                    key={cell.date}
                    type="button"
                    role="gridcell"
                    className={[
                      'cjc-day',
                      cell.inMonth ? '' : 'out',
                      cell.today ? 'today' : '',
                      day === cell.date ? 'selected' : '',
                      cell.count ? 'has-entries' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setDay(cell.date)}
                    aria-label={t('cjc.dayAria', { date: cell.date, count: cell.count })}
                    aria-pressed={day === cell.date}
                  >
                    <span className="cjc-day-num">{cell.day}</span>
                    {cell.count ? <span className="cjc-day-count">{cell.count}</span> : null}
                  </button>
                )))}
              </div>
            </div>

            <div className="cjc-entries">
              <div className="cjc-entries-head">
                <b>
                  {day
                    ? dateLabel(`${day}T00:00:00.000Z`, locale, { weekday: 'short', day: '2-digit', month: '2-digit' })
                    : t('cjc.allMonth')}
                </b>
                {day ? (
                  <button type="button" className="cj-icon-btn" onClick={() => setDay(null)} title={t('cjc.allMonth')} aria-label={t('cjc.allMonth')}>
                    <IconX size={13} />
                  </button>
                ) : null}
                {mine ? (
                  <button type="button" className="cj-btn" onClick={() => setAdding((current) => !current)}>
                    <IconPlus size={13} />
                    {t('cjc.addEntry')}
                  </button>
                ) : null}
              </div>

              {mine && adding ? (
                <form
                  className="cjc-form"
                  onSubmit={(event) => { event.preventDefault(); void addEntry(); }}
                >
                  <p className="cj-dim">{t('cjc.addEntryHint')}</p>
                  <div className="cjc-form-grid">
                    <label>
                      <span>{t('cjc.callsign')}</span>
                      <input
                        value={form.callsign}
                        onChange={(event) => setForm((current) => ({ ...current, callsign: event.target.value }))}
                        placeholder="K7Q-BQL"
                        maxLength={16}
                      />
                    </label>
                    <label>
                      <span>{t('cjc.from')}</span>
                      <input
                        value={form.from}
                        onChange={(event) => setForm((current) => ({ ...current, from: event.target.value }))}
                        placeholder="Sol"
                        maxLength={80}
                      />
                    </label>
                    <label>
                      <span>{t('cjc.to')}</span>
                      <input
                        value={form.to}
                        onChange={(event) => setForm((current) => ({ ...current, to: event.target.value }))}
                        placeholder="Lave"
                        maxLength={80}
                      />
                    </label>
                    <label>
                      <span>{t('cjc.when')}</span>
                      <input
                        type="datetime-local"
                        value={form.when}
                        onChange={(event) => setForm((current) => ({ ...current, when: event.target.value }))}
                      />
                    </label>
                  </div>
                  <label>
                    <span>{t('cjc.entryNote')}</span>
                    <input
                      value={form.note}
                      onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
                      maxLength={500}
                    />
                  </label>
                  <div className="cjc-form-actions">
                    <button type="button" className="cj-btn" onClick={() => setAdding(false)}>{t('cjc.cancel')}</button>
                    <button type="submit" className="cj-btn" disabled={saving || !form.from.trim() || !form.to.trim() || !form.when}>
                      {t('cjc.save')}
                    </button>
                  </div>
                </form>
              ) : null}

              {liveRows.length > 0 && mine ? (
                <details className="cjc-live">
                  <summary>{t('cjc.fromBoard')}</summary>
                  {(
                    <ul>
                      {liveRows.map((row) => (
                        <li key={row.id}>
                          <span className="cjc-live-label">{row.label}</span>
                          <span className="cj-dim">{row.from} → {row.to}</span>
                          <button
                            type="button"
                            className="cj-btn"
                            disabled={saving || !row.departureAt}
                            onClick={() => {
                              if (!row.departureAt) return;
                              setAdding(true);
                              setForm({
                                callsign: row.callsign ?? '',
                                from: row.from,
                                to: row.to,
                                when: isoToLocalInput(row.departureAt),
                                note: '',
                              });
                              setDay(entryDay(row.departureAt));
                              setMonth(monthKey(row.departureAt));
                              toast(t('cjc.fromBoardAdded'), 'success');
                            }}
                          >
                            {t('cjc.fromBoardAdd')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              ) : null}

              {(() => {
                // Выбран день — только его прыжки; иначе весь календарь по порядку.
                const list = day ? dayEntries : [...entries].sort((left, right) => left.departureAt.localeCompare(right.departureAt));
                if (!list.length) {
                  return (
                    <p className="cj-empty-inline">
                      {day ? t('cjc.noDayEntries') : t('cjc.noEntries')}
                    </p>
                  );
                }
                return (
                  <ul className="cjc-entry-list">
                    {list.map((entry) => (
                      <li key={entry.id} className="cjc-entry">
                        <div className="cjc-entry-main">
                          <span className="cjc-entry-time">
                            {dateLabel(entry.departureAt, locale, { day: '2-digit', month: '2-digit' })}
                            {' · '}
                            {timeLabel(entry.departureAt, locale)}
                          </span>
                          <span className="cjc-entry-route">
                            <span>{entry.from}</span>
                            <span className="cj-arrow" aria-hidden="true">→</span>
                            <Link className="cj-target" href={systemPageHref(entry.to)}>{entry.to}</Link>
                          </span>
                          <span className="cjc-entry-carrier">
                            {entry.callsign || entry.name || t('cj.noCallsign')}
                            {entry.callsign && entry.name ? <span className="cj-dim"> · {entry.name}</span> : null}
                          </span>
                          {entry.note ? <span className="cj-dim">{entry.note}</span> : null}
                        </div>
                        <div className="cjc-entry-side">
                          <span className="cj-dim">{byDay.get(entryDay(entry.departureAt))?.length ?? 0}</span>
                          {mine ? (
                            <button
                              type="button"
                              className="cj-icon-btn"
                              onClick={() => void removeEntry(entry.id)}
                              disabled={saving}
                              aria-label={t('cjc.removeEntry')}
                              title={t('cjc.removeEntry')}
                            >
                              <IconX size={13} />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>

            <p className="cj-footnote">{t('cjc.footnote')}</p>
          </>
        )}
      </section>
    </div>
  );
}

export default CarrierJumpCalendar;
