'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authFetch } from '@/lib/supabaseClient';

type ModerationStatus = 'pending' | 'approved' | 'hidden' | 'rejected';
type ViewFilter = 'all' | 'active' | 'completed';

interface CommunityGoalRow {
  id: number;
  cg_id: number;
  title: string;
  description: string | null;
  system_name: string | null;
  station_name: string | null;
  objective: string | null;
  reward: string | null;
  tier_current: number | null;
  tier_max: number | null;
  contributors: number | null;
  contributions_total: number | string | null;
  expiry_date: string | null;
  is_complete: boolean;
  is_colonisation_related: boolean;
  inara_url: string | null;
  source_updated_at: string | null;
  source: 'frontier' | 'inara' | 'capi' | 'journal' | 'manual';
  moderation_status: ModerationStatus;
  manual_overrides: Record<string, unknown>;
  admin_note: string | null;
  updated_at: string | null;
}

interface SourceFreshness {
  records: number;
  latestAt: string | null;
}

interface CommunityGoalSources {
  catalog: Partial<Record<'frontier' | 'inara' | 'capi' | 'journal' | 'manual', SourceFreshness>>;
  helperReports: { latestAt: string | null };
}

interface GoalDraft {
  title: string;
  description: string;
  system_name: string;
  station_name: string;
  objective: string;
  reward: string;
  tier_current: string;
  tier_max: string;
  contributors: string;
  contributions_total: string;
  expiry_date: string;
  is_complete: boolean;
  is_colonisation_related: boolean;
  inara_url: string;
  moderation_status: ModerationStatus;
  admin_note: string;
}

const emptyDraft: GoalDraft = {
  title: '', description: '', system_name: '', station_name: '', objective: '', reward: '',
  tier_current: '', tier_max: '', contributors: '', contributions_total: '', expiry_date: '',
  is_complete: false, is_colonisation_related: true, inara_url: '',
  moderation_status: 'approved', admin_note: '',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--panel, #17191b)', border: '1px solid var(--line, #34383b)',
  borderRadius: 4, padding: 14, marginBottom: 10,
};
const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0 };
const labelStyle: React.CSSProperties = { display: 'grid', gap: 5, color: 'var(--muted)', fontSize: 12 };

function dateInput(value: string | null | undefined): string {
  if (!value) return '';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function draftFromGoal(goal: CommunityGoalRow): GoalDraft {
  return {
    title: goal.title || '', description: goal.description || '', system_name: goal.system_name || '',
    station_name: goal.station_name || '', objective: goal.objective || '', reward: goal.reward || '',
    tier_current: goal.tier_current == null ? '' : String(goal.tier_current),
    tier_max: goal.tier_max == null ? '' : String(goal.tier_max),
    contributors: goal.contributors == null ? '' : String(goal.contributors),
    contributions_total: goal.contributions_total == null ? '' : String(goal.contributions_total),
    expiry_date: dateInput(goal.expiry_date), is_complete: Boolean(goal.is_complete),
    is_colonisation_related: Boolean(goal.is_colonisation_related), inara_url: goal.inara_url || '',
    moderation_status: goal.moderation_status || 'approved', admin_note: goal.admin_note || '',
  };
}

function payloadFromDraft(draft: GoalDraft) {
  const nullableNumber = (value: string) => value.trim() === '' ? null : Number(value);
  return {
    title: draft.title.trim(), description: draft.description,
    system_name: draft.system_name, station_name: draft.station_name,
    objective: draft.objective, reward: draft.reward,
    tier_current: nullableNumber(draft.tier_current), tier_max: nullableNumber(draft.tier_max),
    contributors: nullableNumber(draft.contributors), contributions_total: nullableNumber(draft.contributions_total),
    expiry_date: draft.expiry_date ? new Date(draft.expiry_date).toISOString() : null,
    is_complete: draft.is_complete, is_colonisation_related: draft.is_colonisation_related,
    inara_url: draft.inara_url, moderation_status: draft.moderation_status,
    admin_note: draft.admin_note,
  };
}

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function statusLabel(status: ModerationStatus, t: (key: string) => string) {
  if (status === 'pending') return t('cgAdmin.statusPending');
  if (status === 'hidden') return t('cgAdmin.statusHidden');
  if (status === 'rejected') return t('cgAdmin.statusRejected');
  return t('cgAdmin.statusApproved');
}

function sourceLabel(source: CommunityGoalRow['source'], t: (key: string) => string) {
  if (source === 'manual') return t('cgAdmin.sourceManual');
  if (source === 'frontier') return t('cgAdmin.sourceFrontier');
  if (source === 'capi') return 'Frontier CAPI';
  if (source === 'journal') return t('cgAdmin.sourceJournal');
  return 'Inara';
}

export default function CommunityGoalsAdminTab() {
  const { t, locale } = useI18n();
  const [goals, setGoals] = useState<CommunityGoalRow[]>([]);
  const [sources, setSources] = useState<CommunityGoalSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [view, setView] = useState<ViewFilter>('all');
  const [status, setStatus] = useState<'all' | ModerationStatus>('all');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<CommunityGoalRow | 'new' | null>(null);
  const [draft, setDraft] = useState<GoalDraft>(emptyDraft);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', { cache: 'no-store' }));
      setGoals(Array.isArray(data.goals) ? data.goals : []);
      setSources(data.sources && typeof data.sources === 'object' ? data.sources : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return goals.filter((goal) => {
      if (view === 'active' && goal.is_complete) return false;
      if (view === 'completed' && !goal.is_complete) return false;
      if (status !== 'all' && goal.moderation_status !== status) return false;
      if (!needle) return true;
      return [goal.title, goal.system_name, goal.station_name, goal.objective]
        .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
    });
  }, [goals, view, status, search]);

  const counts = useMemo(() => ({
    all: goals.length,
    active: goals.filter((goal) => !goal.is_complete).length,
    completed: goals.filter((goal) => goal.is_complete).length,
    pending: goals.filter((goal) => goal.moderation_status === 'pending').length,
    pendingJournalActive: goals.filter((goal) => goal.source === 'journal'
      && goal.moderation_status === 'pending'
      && !goal.is_complete
      && Boolean(goal.expiry_date)
      && Date.parse(goal.expiry_date || '') > Date.now()).length,
    pendingJournalStale: goals.filter((goal) => goal.source === 'journal'
      && goal.moderation_status === 'pending'
      && (goal.is_complete || !goal.expiry_date
        || !Number.isFinite(Date.parse(goal.expiry_date))
        || Date.parse(goal.expiry_date) <= Date.now())).length,
    missingGoalText: goals.filter((goal) => !goal.objective?.trim()
      && !goal.description?.trim()
      && !goal.reward?.trim()).length,
    hidden: goals.filter((goal) => goal.moderation_status === 'hidden').length,
    rejected: goals.filter((goal) => goal.moderation_status === 'rejected').length,
  }), [goals]);
  const sourceStatusItems = [
    { key: 'frontier', label: t('cgAdmin.sourceFrontier'), stats: sources?.catalog.frontier },
    { key: 'inara', label: 'Inara', stats: sources?.catalog.inara },
    { key: 'capi', label: 'Frontier CAPI', stats: sources?.catalog.capi },
    { key: 'journal', label: t('cgAdmin.sourceCatalogJournal'), stats: sources?.catalog.journal },
    { key: 'manual', label: t('cgAdmin.sourceCatalogManual'), stats: sources?.catalog.manual },
  ];
  const sourceDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleString(locale) : t('cgAdmin.noData'));

  async function syncNow() {
    setWorking(true);
    setError('');
    setMessage(t('cgAdmin.requesting'));
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync' }),
      }));
      const frontier = data.sources?.frontier;
      const inara = data.sources?.inara;
      const frontierStatus = frontier?.error
        ? t('cgAdmin.frontierError', { error: frontier.error })
        : t('cgAdmin.frontierDone', { received: frontier?.received ?? 0, synced: frontier?.synced ?? 0 });
      const inaraStatus = inara?.skipped
        ? t('cgAdmin.inaraSkipped')
        : inara?.error
          ? t('cgAdmin.inaraError', { error: inara.error })
          : t('cgAdmin.inaraDone', { received: inara?.received ?? 0, synced: inara?.synced ?? 0 });
      setMessage(t('cgAdmin.syncDone', { frontier: frontierStatus, inara: inaraStatus }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errSync'));
      setMessage('');
    } finally {
      setWorking(false);
    }
  }

  async function approveActiveJournalBatch() {
    const confirmed = window.confirm(t('cgAdmin.confirmApproveActive'));
    if (!confirmed) return;
    setWorking(true);
    setError('');
    setMessage(t('cgAdmin.approving'));
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk-approve-current-journal' }),
      }));
      setMessage(t('cgAdmin.approvedCount', { count: Number(data.updated || 0) }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errQueue'));
      setMessage('');
    } finally {
      setWorking(false);
    }
  }

  async function archiveStaleJournalBatch() {
    const confirmed = window.confirm(t('cgAdmin.confirmArchiveStale'));
    if (!confirmed) return;
    setWorking(true);
    setError('');
    setMessage(t('cgAdmin.archiving'));
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk-archive-stale-journal' }),
      }));
      setMessage(t('cgAdmin.archivedCount', { count: Number(data.updated || 0) }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errStale'));
      setMessage('');
    } finally {
      setWorking(false);
    }
  }

  async function syncCapiNow() {
    setWorking(true);
    setError('');
    setMessage(t('cgAdmin.requestingCapi'));
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync-capi' }),
      }));
      setMessage(t('cgAdmin.capiDone', { received: data.received, synced: data.synced }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errCapi'));
      setMessage('');
    } finally {
      setWorking(false);
    }
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError('');
    try {
      const payload: Record<string, unknown> = payloadFromDraft(draft);
      if (editor && editor !== 'new' && editor.source !== 'manual') {
        const original = draftFromGoal(editor);
        const editable = [
          'title', 'description', 'system_name', 'station_name', 'objective', 'reward',
          'tier_current', 'tier_max', 'contributors', 'contributions_total', 'expiry_date',
          'is_complete', 'is_colonisation_related', 'inara_url',
        ] as const;
        for (const field of editable) {
          if (draft[field] === original[field]) delete payload[field];
        }
      }
      if (editor === 'new') {
        await readResponse(await authFetch('/api/admin/community-goals', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', ...payload }),
        }));
        setMessage(t('cgAdmin.created'));
      } else if (editor) {
        await readResponse(await authFetch('/api/admin/community-goals', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editor.id, ...payload }),
        }));
        setMessage(editor.source !== 'manual' ? t('cgAdmin.savedModerated') : t('cgAdmin.saved'));
      }
      setEditor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errSave'));
    } finally {
      setWorking(false);
    }
  }

  async function moderate(goal: CommunityGoalRow, nextStatus: ModerationStatus) {
    setWorking(true);
    setError('');
    try {
      await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goal.id, moderation_status: nextStatus }),
      }));
      setMessage(`${goal.title}: ${statusLabel(nextStatus, t)}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errModerate'));
    } finally {
      setWorking(false);
    }
  }

  async function resetSourceEdits(goal: CommunityGoalRow) {
    if (!window.confirm(t('cgAdmin.confirmReset', { source: sourceLabel(goal.source, t), title: goal.title }))) return;
    setWorking(true);
    setError('');
    try {
      await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goal.id, resetOverrides: true }),
      }));
      setMessage(t('cgAdmin.resetDone'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errReset'));
    } finally {
      setWorking(false);
    }
  }

  async function deleteManualGoal(goal: CommunityGoalRow) {
    if (!window.confirm(t('cgAdmin.confirmDelete', { title: goal.title }))) return;
    setWorking(true);
    setError('');
    try {
      await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goal.id }),
      }));
      setMessage(t('cgAdmin.deleted'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cgAdmin.errDelete'));
    } finally {
      setWorking(false);
    }
  }

  function openCreate() {
    setDraft(emptyDraft);
    setEditor('new');
    setError('');
  }

  function openEdit(goal: CommunityGoalRow) {
    setDraft(draftFromGoal(goal));
    setEditor(goal);
    setError('');
  }

  const input = (field: keyof GoalDraft, label: string, type = 'text') => (
    <label style={labelStyle} key={field}>
      {label}
      <input
        type={type}
        style={inputStyle}
        value={String(draft[field])}
        onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
      />
    </label>
  );

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ marginBottom: 6 }}>{t('cgAdmin.title')}</h2>
          <p style={{ color: 'var(--muted)', maxWidth: 900, fontSize: 13, marginTop: 0 }}>
            {t('cgAdmin.intro')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-cyan" disabled={working} onClick={() => void syncNow()}>
            {working ? t('cgAdmin.working') : t('cgAdmin.syncSources')}
          </button>
          <button type="button" className="btn" disabled={working} onClick={() => void syncCapiNow()}>
            {working ? t('cgAdmin.working') : t('cgAdmin.requestCapi')}
          </button>
          <button type="button" className="btn" disabled={working} onClick={() => void load()}>{t('cgAdmin.refreshList')}</button>
          <button type="button" className="btn btn-cyan" disabled={working || counts.pendingJournalActive === 0} onClick={() => void approveActiveJournalBatch()} title={t('cgAdmin.approveActiveTitle')}>{t('cgAdmin.approveActive', { count: counts.pendingJournalActive })}</button>
          <button type="button" className="btn" disabled={working || counts.pendingJournalStale === 0} onClick={() => void archiveStaleJournalBatch()} title={t('cgAdmin.archiveStaleTitle')}>{t('cgAdmin.archiveStale', { count: counts.pendingJournalStale })}</button>
          <button type="button" className="btn btn-orange" disabled={working} onClick={openCreate}>{t('cgAdmin.create')}</button>
        </div>
      </div>

      <div style={{ ...cardStyle, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--muted)', fontSize: 13 }}>
        <span>{t('cgAdmin.statAll')}: <strong>{counts.all}</strong></span>
        <span>{t('cgAdmin.statActive')}: <strong>{counts.active}</strong></span>
        <span>{t('cgAdmin.statCompleted')}: <strong>{counts.completed}</strong></span>
        <span>{t('cgAdmin.statPending')}: <strong>{counts.pending}</strong></span>
        <span>{t('cgAdmin.statPendingJournalActive')}: <strong>{counts.pendingJournalActive}</strong></span>
        <span>{t('cgAdmin.statPendingJournalStale')}: <strong>{counts.pendingJournalStale}</strong></span>
        <span>{t('cgAdmin.statMissingText')}: <strong>{counts.missingGoalText}</strong></span>
        <span>{t('cgAdmin.statHidden')}: <strong>{counts.hidden}</strong></span>
        <span>{t('cgAdmin.statRejected')}: <strong>{counts.rejected}</strong></span>
      </div>

      <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {sourceStatusItems.map(({ key, label, stats }) => (
          <div key={key} style={{ minWidth: 0, padding: 10, border: '1px solid var(--line)', borderRadius: 4 }}>
            <strong>{label}</strong>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>{t('cgAdmin.catalogRecords', { count: stats?.records ?? 0 })}</div>
            <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 3 }}>{t('cgAdmin.catalogLatest', { when: sourceDate(stats?.latestAt) })}</div>
          </div>
        ))}
        <div style={{ minWidth: 0, padding: 10, border: '1px solid var(--line)', borderRadius: 4 }}>
          <strong>{t('cgAdmin.helperReports')}</strong>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>{t('cgAdmin.helperLatest', { when: sourceDate(sources?.helperReports.latestAt) })}</div>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 3 }}>{t('cgAdmin.helperNote')}</div>
        </div>
      </div>

      {message && <p role="status" style={{ color: 'var(--green, #6fcf97)' }}>{message}</p>}
      {error && <p role="alert" style={{ color: 'var(--red, #ef6464)' }}>{error}</p>}

      <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <label style={labelStyle}>{t('cgAdmin.filterShow')}
          <select style={inputStyle} value={view} onChange={(event) => setView(event.target.value as ViewFilter)}>
            <option value="all">{t('cgAdmin.optAllStates')}</option><option value="active">{t('cgAdmin.optActive')}</option><option value="completed">{t('cgAdmin.optCompleted')}</option>
          </select>
        </label>
        <label style={labelStyle}>{t('cgAdmin.filterModeration')}
          <select style={inputStyle} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">{t('cgAdmin.optAnyStatus')}</option><option value="pending">{t('cgAdmin.statusPending')}</option><option value="approved">{t('cgAdmin.statusApproved')}</option><option value="hidden">{t('cgAdmin.statusHidden')}</option><option value="rejected">{t('cgAdmin.statusRejected')}</option>
          </select>
        </label>
        <label style={labelStyle}>{t('cgAdmin.filterSearch')}
          <input style={inputStyle} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('cgAdmin.placeholderSearch')} />
        </label>
      </div>

      {loading ? <p role="status">{t('cgAdmin.loading')}</p> : filtered.length === 0 ? <p style={{ color: 'var(--muted)' }}>{t('cgAdmin.emptyFiltered')}</p> : (
        <div aria-live="polite">
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>{t('cgAdmin.shown', { shown: filtered.length, total: goals.length })}</p>
          {filtered.map((goal) => (
            <article key={goal.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 240, flex: '1 1 360px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{goal.title}</strong>
                    <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10, color: 'var(--muted)' }}>{sourceLabel(goal.source, t)}</span>
                    <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10, color: goal.moderation_status === 'approved' ? 'var(--green, #6fcf97)' : 'var(--orange)' }}>{statusLabel(goal.moderation_status, t)}</span>
                    {goal.is_complete && <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10 }}>{t('cgAdmin.badgeComplete')}</span>}
                    {goal.is_colonisation_related && <span style={{ border: '1px solid var(--orange)', padding: '2px 6px', fontSize: 10, color: 'var(--orange)' }}>{t('cgAdmin.badgeColonisation')}</span>}
                    {Object.keys(goal.manual_overrides || {}).length > 0 && <span style={{ fontSize: 10, color: 'var(--cyan)' }}>{t('cgAdmin.badgeOverrides')}</span>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                    {[goal.system_name, goal.station_name].filter(Boolean).join(' · ') || t('cgAdmin.placeUnknown')}
                    {goal.expiry_date && t('cgAdmin.until', { when: new Date(goal.expiry_date).toLocaleString(locale) })}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                    {t('cgAdmin.tierLine', {
                      tier: goal.tier_current ?? '—',
                      max: goal.tier_max ?? '—',
                      contributors: goal.contributors ?? '—',
                      total: goal.contributions_total == null ? '—' : Number(goal.contributions_total).toLocaleString(locale),
                    })}
                  </div>
                  {goal.admin_note && <div style={{ fontSize: 12, marginTop: 6 }}>{t('cgAdmin.adminNote', { note: goal.admin_note })}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flexWrap: 'wrap' }}>
                  <button type="button" className="btn" disabled={working} onClick={() => openEdit(goal)}>{t('cgAdmin.edit')}</button>
                  {goal.moderation_status !== 'approved' && <button type="button" className="btn btn-cyan" disabled={working} onClick={() => void moderate(goal, 'approved')}>{t('cgAdmin.publish')}</button>}
                  {goal.moderation_status !== 'hidden' && <button type="button" className="btn" disabled={working} onClick={() => void moderate(goal, 'hidden')}>{t('cgAdmin.hide')}</button>}
                  {goal.moderation_status !== 'rejected' && <button type="button" className="btn" disabled={working} onClick={() => void moderate(goal, 'rejected')}>{t('cgAdmin.reject')}</button>}
                  {goal.source !== 'manual' && Object.keys(goal.manual_overrides || {}).length > 0 && <button type="button" className="btn" disabled={working} onClick={() => void resetSourceEdits(goal)}>{t('cgAdmin.resetEdits')}</button>}
                  {goal.source === 'manual' && <button type="button" className="btn btn-danger" disabled={working} onClick={() => void deleteManualGoal(goal)}>{t('cgAdmin.delete')}</button>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {editor && (
        <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setEditor(null); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.72)', overflowY: 'auto', padding: 18, display: 'grid', placeItems: 'start center' }}>
          <form onSubmit={(event) => void saveDraft(event)} role="dialog" aria-modal="true" aria-labelledby="cg-editor-title" style={{ ...cardStyle, width: 'min(900px, 100%)', margin: '4vh 0', background: 'var(--bg, #111315)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <h3 id="cg-editor-title" style={{ marginTop: 0 }}>{editor === 'new' ? t('cgAdmin.newTitle') : t('cgAdmin.editTitle', { title: editor.title })}</h3>
              <button type="button" className="btn" disabled={working} onClick={() => setEditor(null)}>{t('cgAdmin.close')}</button>
            </div>
            {editor !== 'new' && editor.source !== 'manual' && <p style={{ color: 'var(--muted)', fontSize: 12 }}>{t('cgAdmin.overrideNote')}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
              {input('title', t('cgAdmin.fieldTitle'))}
              {input('system_name', t('cgAdmin.fieldSystem'))}
              {input('station_name', t('cgAdmin.fieldStation'))}
              {input('expiry_date', t('cgAdmin.fieldExpiry'), 'datetime-local')}
              {input('tier_current', t('cgAdmin.fieldTierCurrent'), 'number')}
              {input('tier_max', t('cgAdmin.fieldTierMax'), 'number')}
              {input('contributors', t('cgAdmin.fieldContributors'), 'number')}
              {input('contributions_total', t('cgAdmin.fieldTotal'), 'number')}
              {input('inara_url', t('cgAdmin.fieldInara'))}
              {editor !== 'new' && <label style={labelStyle}>{t('cgAdmin.filterModeration')}
                <select style={inputStyle} value={draft.moderation_status} onChange={(event) => setDraft((current) => ({ ...current, moderation_status: event.target.value as ModerationStatus }))}>
                  <option value="pending">{t('cgAdmin.statusPending')}</option><option value="approved">{t('cgAdmin.statusApproved')}</option><option value="hidden">{t('cgAdmin.statusHidden')}</option><option value="rejected">{t('cgAdmin.statusRejected')}</option>
                </select>
              </label>}
              <label style={labelStyle}>{t('cgAdmin.fieldColonisation')}
                <input type="checkbox" checked={draft.is_colonisation_related} onChange={(event) => setDraft((current) => ({ ...current, is_colonisation_related: event.target.checked }))} />
              </label>
              <label style={labelStyle}>{t('cgAdmin.fieldComplete')}
                <input type="checkbox" checked={draft.is_complete} onChange={(event) => setDraft((current) => ({ ...current, is_complete: event.target.checked }))} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 12 }}>
              <label style={labelStyle}>{t('cgAdmin.fieldObjective')}<textarea rows={4} style={inputStyle} value={draft.objective} onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))} /></label>
              <label style={labelStyle}>{t('cgAdmin.fieldDescription')}<textarea rows={4} style={inputStyle} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
              <label style={labelStyle}>{t('cgAdmin.fieldReward')}<textarea rows={4} style={inputStyle} value={draft.reward} onChange={(event) => setDraft((current) => ({ ...current, reward: event.target.value }))} /></label>
              <label style={labelStyle}>{t('cgAdmin.fieldAdminNote')}<textarea rows={4} style={inputStyle} value={draft.admin_note} onChange={(event) => setDraft((current) => ({ ...current, admin_note: event.target.value }))} /></label>
            </div>
            {error && <p role="alert" style={{ color: 'var(--red, #ef6464)' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn" disabled={working} onClick={() => setEditor(null)}>{t('cgAdmin.cancel')}</button>
              <button type="submit" className="btn btn-cyan" disabled={working}>{working ? t('cgAdmin.saving') : t('cgAdmin.save')}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
