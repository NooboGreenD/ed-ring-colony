'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/supabaseClient';

type ModerationStatus = 'approved' | 'hidden' | 'rejected';
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
  source: 'inara' | 'manual';
  moderation_status: ModerationStatus;
  manual_overrides: Record<string, unknown>;
  admin_note: string | null;
  updated_at: string | null;
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

function statusLabel(status: ModerationStatus) {
  if (status === 'hidden') return 'Скрыта';
  if (status === 'rejected') return 'Отклонена';
  return 'Опубликована';
}

export default function CommunityGoalsAdminTab() {
  const [goals, setGoals] = useState<CommunityGoalRow[]>([]);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить Community Goals');
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
    hidden: goals.filter((goal) => goal.moderation_status === 'hidden').length,
    rejected: goals.filter((goal) => goal.moderation_status === 'rejected').length,
  }), [goals]);
  const latestInaraUpdate = useMemo(() => goals
    .filter((goal) => goal.source === 'inara' && goal.source_updated_at)
    .map((goal) => goal.source_updated_at as string)
    .sort()
    .at(-1) || null, [goals]);

  async function syncNow() {
    setWorking(true);
    setError('');
    setMessage('Запрашиваем актуальный список у Inara…');
    try {
      const data = await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync' }),
      }));
      setMessage(`Синхронизация завершена: получено ${data.received}, обновлено ${data.synced}, завершённых в ответе Inara — ${data.completed}. Ранее загруженные CG не удаляются.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Синхронизация Inara не удалась');
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
      if (editor !== 'new' && editor?.source === 'inara') {
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
        setMessage('Локальная колонизационная CG создана и опубликована.');
      } else if (editor) {
        await readResponse(await authFetch('/api/admin/community-goals', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editor.id, ...payload }),
        }));
        setMessage(editor.source === 'inara' ? 'Изменения модератора сохранены как override и сохранятся после синхронизации Inara.' : 'Изменения CG сохранены.');
      }
      setEditor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить CG');
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
      setMessage(`${goal.title}: ${statusLabel(nextStatus).toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось применить решение модерации');
    } finally {
      setWorking(false);
    }
  }

  async function resetInaraEdits(goal: CommunityGoalRow) {
    if (!window.confirm(`Сбросить локальные правки и восстановить исходные данные Inara для «${goal.title}»?`)) return;
    setWorking(true);
    setError('');
    try {
      await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goal.id, resetOverrides: true }),
      }));
      setMessage('Локальные правки удалены; отображаются исходные данные Inara.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сбросить правки');
    } finally {
      setWorking(false);
    }
  }

  async function deleteManualGoal(goal: CommunityGoalRow) {
    if (!window.confirm(`Безвозвратно удалить локальную CG «${goal.title}»?`)) return;
    setWorking(true);
    setError('');
    try {
      await readResponse(await authFetch('/api/admin/community-goals', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goal.id }),
      }));
      setMessage('Локальная CG удалена.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить CG');
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
          <h2 style={{ marginBottom: 6 }}>Community Goals — синхронизация и модерация</h2>
          <p style={{ color: 'var(--muted)', maxWidth: 900, fontSize: 13, marginTop: 0 }}>
            Плановая синхронизация выполняется раз в шесть часов; здесь можно запустить её вне расписания. Из Inara поступают текущие и недавние завершённые CG. Все загруженные записи сохраняются в каталоге, а локальные правки Inara хранятся отдельно от исходных данных.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-cyan" disabled={working} onClick={() => void syncNow()}>
            {working ? 'Обработка…' : 'Синхронизировать с Inara'}
          </button>
          <button type="button" className="btn" disabled={working} onClick={() => void load()}>Обновить список</button>
          <button type="button" className="btn btn-orange" disabled={working} onClick={openCreate}>Создать колонизационную CG</button>
        </div>
      </div>

      <div style={{ ...cardStyle, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--muted)', fontSize: 13 }}>
        <span>Всего: <strong>{counts.all}</strong></span>
        <span>Активных: <strong>{counts.active}</strong></span>
        <span>Завершённых: <strong>{counts.completed}</strong></span>
        <span>Скрытых: <strong>{counts.hidden}</strong></span>
        <span>Отклонённых: <strong>{counts.rejected}</strong></span>
        <span>Последнее обновление источника Inara: <strong>{latestInaraUpdate ? new Date(latestInaraUpdate).toLocaleString() : '—'}</strong></span>
      </div>

      {message && <p role="status" style={{ color: 'var(--green, #6fcf97)' }}>{message}</p>}
      {error && <p role="alert" style={{ color: 'var(--red, #ef6464)' }}>{error}</p>}

      <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <label style={labelStyle}>Показать
          <select style={inputStyle} value={view} onChange={(event) => setView(event.target.value as ViewFilter)}>
            <option value="all">Все состояния</option><option value="active">Активные</option><option value="completed">Завершённые</option>
          </select>
        </label>
        <label style={labelStyle}>Модерация
          <select style={inputStyle} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">Любой статус</option><option value="approved">Опубликована</option><option value="hidden">Скрыта</option><option value="rejected">Отклонена</option>
          </select>
        </label>
        <label style={labelStyle}>Поиск по названию / системе / станции
          <input style={inputStyle} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Название, система или станция" />
        </label>
      </div>

      {loading ? <p role="status">Загружаем каталог CG…</p> : filtered.length === 0 ? <p style={{ color: 'var(--muted)' }}>По выбранным фильтрам CG не найдены.</p> : (
        <div aria-live="polite">
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>Показано {filtered.length} из {goals.length} CG</p>
          {filtered.map((goal) => (
            <article key={goal.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 240, flex: '1 1 360px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{goal.title}</strong>
                    <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10, color: 'var(--muted)' }}>{goal.source === 'manual' ? 'Локальная' : 'Inara'}</span>
                    <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10, color: goal.moderation_status === 'approved' ? 'var(--green, #6fcf97)' : 'var(--orange)' }}>{statusLabel(goal.moderation_status)}</span>
                    {goal.is_complete && <span style={{ border: '1px solid var(--line)', padding: '2px 6px', fontSize: 10 }}>Завершена</span>}
                    {goal.is_colonisation_related && <span style={{ border: '1px solid var(--orange)', padding: '2px 6px', fontSize: 10, color: 'var(--orange)' }}>Колонизация</span>}
                    {Object.keys(goal.manual_overrides || {}).length > 0 && <span style={{ fontSize: 10, color: 'var(--cyan)' }}>Есть локальные правки</span>}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                    {[goal.system_name, goal.station_name].filter(Boolean).join(' · ') || 'Место не указано'}
                    {goal.expiry_date && ` · до ${new Date(goal.expiry_date).toLocaleString()}`}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                    Тир: {goal.tier_current ?? '—'} / {goal.tier_max ?? '—'} · Участников: {goal.contributors ?? '—'} · Вклад: {goal.contributions_total == null ? '—' : Number(goal.contributions_total).toLocaleString()}
                  </div>
                  {goal.admin_note && <div style={{ fontSize: 12, marginTop: 6 }}>Заметка модератора: {goal.admin_note}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flexWrap: 'wrap' }}>
                  <button type="button" className="btn" disabled={working} onClick={() => openEdit(goal)}>Редактировать</button>
                  {goal.moderation_status !== 'approved' && <button type="button" className="btn btn-cyan" disabled={working} onClick={() => void moderate(goal, 'approved')}>Опубликовать</button>}
                  {goal.moderation_status !== 'hidden' && <button type="button" className="btn" disabled={working} onClick={() => void moderate(goal, 'hidden')}>Скрыть</button>}
                  {goal.moderation_status !== 'rejected' && <button type="button" className="btn" disabled={working} onClick={() => void moderate(goal, 'rejected')}>Отклонить</button>}
                  {goal.source === 'inara' && Object.keys(goal.manual_overrides || {}).length > 0 && <button type="button" className="btn" disabled={working} onClick={() => void resetInaraEdits(goal)}>Сбросить правки</button>}
                  {goal.source === 'manual' && <button type="button" className="btn btn-danger" disabled={working} onClick={() => void deleteManualGoal(goal)}>Удалить</button>}
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
              <h3 id="cg-editor-title" style={{ marginTop: 0 }}>{editor === 'new' ? 'Новая колонизационная CG' : `Редактирование: ${editor.title}`}</h3>
              <button type="button" className="btn" disabled={working} onClick={() => setEditor(null)}>Закрыть</button>
            </div>
            {editor !== 'new' && editor.source === 'inara' && <p style={{ color: 'var(--muted)', fontSize: 12 }}>Изменения будут сохранены как модераторские overrides и не затрут исходные данные Inara при следующем обновлении.</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
              {input('title', 'Название CG *')}
              {input('system_name', 'Звёздная система')}
              {input('station_name', 'Станция / порт')}
              {input('expiry_date', 'Срок завершения', 'datetime-local')}
              {input('tier_current', 'Текущий тир', 'number')}
              {input('tier_max', 'Максимальный тир', 'number')}
              {input('contributors', 'Участники', 'number')}
              {input('contributions_total', 'Общий вклад', 'number')}
              {input('inara_url', 'Ссылка Inara')}
              {editor !== 'new' && <label style={labelStyle}>Модерация
                <select style={inputStyle} value={draft.moderation_status} onChange={(event) => setDraft((current) => ({ ...current, moderation_status: event.target.value as ModerationStatus }))}>
                  <option value="approved">Опубликована</option><option value="hidden">Скрыта</option><option value="rejected">Отклонена</option>
                </select>
              </label>}
              <label style={labelStyle}>Объект колонизации
                <input type="checkbox" checked={draft.is_colonisation_related} onChange={(event) => setDraft((current) => ({ ...current, is_colonisation_related: event.target.checked }))} />
              </label>
              <label style={labelStyle}>CG завершена
                <input type="checkbox" checked={draft.is_complete} onChange={(event) => setDraft((current) => ({ ...current, is_complete: event.target.checked }))} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 12 }}>
              <label style={labelStyle}>Цель / условия<textarea rows={4} style={inputStyle} value={draft.objective} onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))} /></label>
              <label style={labelStyle}>Описание<textarea rows={4} style={inputStyle} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
              <label style={labelStyle}>Награда<textarea rows={4} style={inputStyle} value={draft.reward} onChange={(event) => setDraft((current) => ({ ...current, reward: event.target.value }))} /></label>
              <label style={labelStyle}>Заметка модератора<textarea rows={4} style={inputStyle} value={draft.admin_note} onChange={(event) => setDraft((current) => ({ ...current, admin_note: event.target.value }))} /></label>
            </div>
            {error && <p role="alert" style={{ color: 'var(--red, #ef6464)' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn" disabled={working} onClick={() => setEditor(null)}>Отмена</button>
              <button type="submit" className="btn btn-cyan" disabled={working}>{working ? 'Сохраняем…' : 'Сохранить'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
