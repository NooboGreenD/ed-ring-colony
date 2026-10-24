'use client';

import { useCallback, useEffect, useState } from 'react';
import { IconCheck, IconError, IconSync, IconWaiting } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';
import { capiReasonText, describeJournalStatus } from '@/lib/capi/messages';
import { platformSelection } from '@/lib/capi/platform';

interface CapiProfileData {
  cmdr_name: string | null;
  credits: number | null;
  loan?: number | null;
  cqc_rank?: number | null;
  combat_rank: number | null;
  trade_rank: number | null;
  explore_rank: number | null;
  empire_rank: number | null;
  federation_rank: number | null;
  current_ship: string | null;
  current_system: string | null;
  current_station?: string | null;
  ships?: unknown[] | null;
  last_updated: string;
}

type BindingData = {
  status: 'linked' | 'already_linked' | 'conflict' | 'missing';
  siteName: string | null;
  capiName: string | null;
  linked: boolean;
  tokenActive: boolean;
  accessExpired: boolean | null;
  expiresAt: string | null;
  linkedAt: string | null;
  platform: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
};

type SyncReport = {
  cmdrName: string | null;
  journalStatus: string;
  eventsImported: number;
  eventsDuplicate: number;
  warnings: string[];
  durationMs?: number | null;
  jobId?: string;
  stageTimings?: Array<{ stage: string; attempt?: number; durationMs: number }>;
};

type SyncJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string;
  requested_at?: string;
  attempts?: number;
  total_duration_ms?: number | null;
  stage_timings?: Array<{ stage: string; attempt?: number; durationMs: number }> | null;
  error?: string | null;
  result?: {
    ok?: boolean; cmdrName?: string | null; journalStatus?: string;
    eventsImported?: number; eventsDuplicate?: number; warnings?: string[];
    needsReauth?: boolean; error?: string | null; detail?: string | null;
  } | null;
};

function syncStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: 'Задание ожидает worker', starting: 'Worker забрал задание', token_lookup: 'Проверка сайт-привязки Frontier',
    session: 'Проверка и обновление сессии Frontier',
    profile_request: 'Запрос профиля Frontier', profile_received: 'Профиль получен',
    profile_site_lookup: 'Проверка привязки профиля сайта', profile_save: 'Сохранение профиля',
    community_goals_request: 'Запрос необязательных Community Goals', community_goals_save: 'Сохранение каталога Community Goals',
    stats_save: 'Сохранение статистики командира', member_location: 'Обновление положения в эскадрилье',
    journal_request: 'Запрос журнала Frontier', journal_parse: 'Разбор JSON журнала',
    journal_reports_save: 'Сохранение отчётов Community Goals из журнала',
    journal_reports_catalog: 'Обновление каталога Community Goals из журнала',
    journal_sites_save: 'Запись событий колонизации', journal_snapshots_save: 'Запись снимков прогресса',
    journal_projects_sync: 'Синхронизация проектов эскадрилий',
    journal_observations_parse: 'Разбор наблюдений систем', journal_observations_save: 'Запись фракций и PowerPlay из журнала',
    finalize: 'Завершение и запись результата', succeeded: 'Завершено', failed: 'Ошибка',
    worker_lost: 'Worker не ответил; превышено число повторных попыток',
  };
  return labels[stage] || `Этап: ${stage.replaceAll('_', ' ')}`;
}

type Diagnostics = {
  config: Record<string, unknown>;
  link: Record<string, unknown>;
  stored: Record<string, unknown>;
  live: Record<string, unknown> | null;
};

type NetworkCheck = {
  checkedAt: string;
  timeoutMs: { dns: number; https: number };
  probes: Array<{
    host: string;
    reachable: boolean;
    dns: { ok: boolean; addressCount?: number; durationMs: number; code?: string; error?: string };
    https: { ok: boolean; status?: number; durationMs: number; code?: string; error?: string };
  }>;
};

const RANK_NAMES = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const EMPIRE_RANKS = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FED_RANKS = ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lt. Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];

/**
 * Платформы аккаунта: у Frontier это параметр `audience`.
 *
 * «Определить автоматически» (`auto` → `frontier,steam,epic`) стоит первым и
 * выбран по умолчанию: с одним лишь `frontier` пилот, купивший игру в Steam
 * или Epic, проходит авторизацию, но получает токен учётки магазина — и CAPI
 * отвечает `400 Please Visit the store to purchase Elite: Dangerous`.
 */
const PLATFORMS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Определить автоматически' },
  { id: 'frontier', label: 'Frontier' },
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic Games Store (EGS)' },
  { id: 'xbox', label: 'Xbox' },
  { id: 'psn', label: 'PlayStation' },
];

function rankLabel(list: string[], value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return list[value] ?? String(value);
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('ru-RU');
}

export default function CapiPage() {
  const [profile, setProfile] = useState<CapiProfileData | null>(null);
  const [binding, setBinding] = useState<BindingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'partial' | 'error'; title: string; hint: string; detail?: string } | null>(null);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);
  const [platform, setPlatform] = useState('auto');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [networkCheck, setNetworkCheck] = useState<NetworkCheck | null>(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await authFetch('/api/capi/profile');
      if (res.ok) {
        const data = await res.json();
        setProfile(data.profile ?? null);
        setBinding(data.binding ?? null);
      } else if (res.status === 401) {
        setError('Сессия сайта истекла — войдите заново.');
      }
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : 'Не удалось загрузить профиль');
    } finally {
      setLoading(false);
    }
  }, []);

  // Результат колбэка OAuth приходит в адресной строке. Раньше страница эти
  // параметры игнорировала — поэтому любая осечка выглядела как «ничего не
  // произошло». Читаем их, показываем и убираем из URL, чтобы обновление
  // страницы не повторяло старое сообщение.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    if (status) {
      const reason = params.get('reason');
      const detail = params.get('detail');
      const cmdr = params.get('cmdr');
      const text = capiReasonText(reason);

      if (status === 'success') {
        setNotice({
          kind: 'success',
          title: cmdr ? `Аккаунт Frontier привязан: CMDR ${cmdr}` : 'Аккаунт Frontier привязан',
          hint: reason ? text.hint : 'Данные командира загружены. Дальше они обновляются по кнопке «Синхронизировать» и по расписанию.',
        });
      } else {
        setNotice({
          kind: status === 'partial' ? 'partial' : 'error',
          title: text.title,
          hint: text.hint,
          detail: detail || undefined,
        });
      }
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Платформа из колбэка: сервер передаёт `audience` потока. Список (авто)
    // превращаем обратно в «auto», одиночное значение — в выбор селектора.
    const returnedPlatform = params.get('platform');
    if (returnedPlatform) {
      setPlatform(platformSelection(returnedPlatform));
    }
    void fetchProfile();
    void resumeActiveSync();
  }, [fetchProfile]);

  function reportFromJob(job: SyncJob): SyncReport {
    return {
      cmdrName: job.result?.cmdrName ?? null,
      journalStatus: job.result?.journalStatus ?? 'error',
      eventsImported: job.result?.eventsImported ?? 0,
      eventsDuplicate: job.result?.eventsDuplicate ?? 0,
      warnings: Array.isArray(job.result?.warnings) ? job.result.warnings : [],
      durationMs: job.total_duration_ms ?? null,
      jobId: job.id,
      stageTimings: Array.isArray(job.stage_timings) ? job.stage_timings : [],
    };
  }

  async function pollSyncJob(jobId: string) {
    while (true) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const res = await authFetch(`/api/capi/sync/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.job) throw new Error(data.error || `Не удалось проверить состояние синхронизации (HTTP ${res.status})`);

      const job = data.job as SyncJob;
      setSyncJob(job);
      if (job.status === 'queued' || job.status === 'running') continue;

      setNotice(null);
      if (job.status === 'succeeded') {
        setSyncReport(reportFromJob(job));
        setError(null);
      } else {
        setSyncReport(job.result ? reportFromJob(job) : null);
        const message = [job.result?.error || job.error || 'Фоновая синхронизация завершилась ошибкой', job.result?.detail]
          .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
          .join(' · ');
        setError(job.result?.needsReauth ? `${message} — подключите аккаунт заново.` : message);
      }
      await fetchProfile();
      return;
    }
  }

  async function resumeActiveSync() {
    try {
      const res = await authFetch('/api/capi/sync', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const job = data.job as SyncJob | null;
      if (!job) return;
      setSyncJob(job);
      setSyncing(true);
      await pollSyncJob(job.id);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Не удалось продолжить синхронизацию');
    } finally {
      setSyncing(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setSyncReport(null);
    try {
      const res = await authFetch('/api/capi/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.job) {
        const fallbackError = `Не удалось поставить синхронизацию в очередь (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''})`;
        setError(data.needsAuth ? `${data.error || fallbackError}. Подключите Frontier.` : data.error || fallbackError);
        return;
      }
      const job = data.job as SyncJob;
      setSyncJob(job);
      await pollSyncJob(job.id);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Не удалось поставить синхронизацию в очередь');
    } finally {
      setSyncing(false);
    }
  }

  async function handleUnlink() {
    if (!window.confirm('Отвязать аккаунт Frontier? Данные CAPI будут удалены.')) return;
    setError(null);
    const res = await authFetch('/api/capi/unlink', { method: 'DELETE' });
    if (res.ok) {
      setProfile(null);
      setDiagnostics(null);
      setSyncReport(null);
      setNotice({ kind: 'partial', title: 'Аккаунт Frontier отвязан', hint: 'Можно подключить его заново в любой момент.' });
      await fetchProfile();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Не удалось отвязать аккаунт');
    }
  }

  async function handleDiagnostics() {
    setDiagLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/capi/status?probe=1');
      const data = await res.json();
      if (res.ok) setDiagnostics(data);
      else setError(data.error || 'Диагностика недоступна');
    } catch (diagError) {
      setError(diagError instanceof Error ? diagError.message : 'Диагностика недоступна');
    } finally {
      setDiagLoading(false);
    }
  }

  async function handleNetworkCheck() {
    setNetworkLoading(true);
    setNetworkError(null);
    try {
      const res = await authFetch('/api/capi/network-check', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) setNetworkCheck(data as NetworkCheck);
      else setNetworkError(data.error || 'Проверка сети недоступна');
    } catch (checkError) {
      setNetworkError(checkError instanceof Error ? checkError.message : 'Проверка сети недоступна');
    } finally {
      setNetworkLoading(false);
    }
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)' }}>Загрузка...</div>;

  // Привязка определяется токеном, а не кэшем профиля: строка в
  // capi_profiles может отсутствовать при живой связи (командир ещё не
  // заходил в игру, CAPI на обслуживании), и предлагать «подключить»
  // повторно в такой ситуации — вводить пилота в заблуждение.
  const linked = Boolean(binding?.linked);
  const needsReauth = linked && binding?.tokenActive === false;
  const hasCapiError = linked && !needsReauth && Boolean(binding?.lastError);
  const frontierStoreEntitlementError = hasCapiError
    && binding?.platform === 'frontier'
    && Boolean(binding.lastError?.includes('CAPI Frontier не подтвердил доступ к Elite Dangerous'));
  const profileEmpty = linked && (!profile || (profile.credits === null && !profile.current_system));

  return (
    <div style={{ padding: '24px 20px', maxWidth: 800 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 12 }}>
        FRONTIER CAPI
      </h2>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 20 }}>
        Эта привязка принадлежит сайту. Colonial Helper может запрашивать синхронизацию только через токен проекта;
        Frontier-токены остаются на сервере и без привязки на сайте Helper не получит доступ.
      </p>

      {notice && (
        <div className={`capi-notice capi-notice-${notice.kind}`}>
          <strong>
            {notice.kind === 'success' ? <IconCheck size={14} /> : notice.kind === 'partial' ? <IconWaiting size={14} /> : <IconError size={14} />}
            {' '}{notice.title}
          </strong>
          <div className="capi-notice-hint">{notice.hint}</div>
          {notice.detail && <div className="capi-notice-detail">{notice.detail}</div>}
        </div>
      )}

      {error && (
        <div className="capi-notice capi-notice-error">
          <strong><IconError size={14} /> {error}</strong>
        </div>
      )}

      {!linked ? (
        <div className="card">
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Подключите аккаунт Frontier, чтобы досье пилота заполнялось из Companion API:
            ранги, кредиты, корабли, текущая система и события колонизации.
          </p>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
            Выберите, как вы входите в Elite Dangerous — диалог Frontier покажет именно этот способ входа.
            Если не уверены, оставьте «Определить автоматически»: Frontier сам предложит Steam, Epic или вход почтой.
            Ответ «Please Visit the store to purchase Elite: Dangerous» означает отказ CAPI в проверке прав на игру,
            но сам по себе не доказывает, что выбрана не та платформа.
          </p>
          <div className="capi-platforms">
            {PLATFORMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`capi-platform${platform === item.id ? ' capi-platform-active' : ''}`}
                onClick={() => setPlatform(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <a href={`/api/capi/auth?platform=${platform}`} className="btn btn-orange">Подключить Frontier Account</a>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="capi-head">
              <div className={needsReauth ? 'capi-status-broken' : hasCapiError ? 'capi-status-pending' : 'capi-status-connected'}>
                <span className="capi-dot" style={{ background: needsReauth ? 'var(--red)' : hasCapiError ? 'var(--orange)' : 'var(--green)' }} />
                {needsReauth ? 'Требуется повторная авторизация' : hasCapiError ? 'Авторизация сохранена, CAPI недоступен' : 'Подключено'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-cyan" onClick={handleSync} disabled={syncing}>
                  <IconSync size={14} /> {syncing ? 'Синхр...' : 'Синхронизировать'}
                </button>
                <button className="btn" onClick={handleDiagnostics} disabled={diagLoading}>
                  {diagLoading ? 'Проверка...' : 'Диагностика'}
                </button>
                <button className="btn" onClick={handleNetworkCheck} disabled={networkLoading}>
                  {networkLoading ? 'Проверяю сеть...' : 'Проверить сеть сервера'}
                </button>
                <button className="btn danger-btn" onClick={handleUnlink}>Отвязать</button>
              </div>
            </div>

            <p style={{ fontFamily: 'ui-monospace', fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
              CMDR: <span style={{ color: 'var(--orange)' }}>{profile?.cmdr_name || binding?.capiName || '—'}</span>
              {' | '}Обновлено: {dateLabel(profile?.last_updated)}
              {binding?.platform ? ` | Платформа: ${binding.platform}` : ''}
            </p>

            {syncing && (
              <div className="capi-notice capi-notice-partial" role="status" style={{ marginTop: 12 }}>
                <strong><IconWaiting size={14} /> {syncJob ? syncStageLabel(syncJob.stage) : 'Постановка в очередь синхронизации'}</strong>
                <div className="capi-notice-hint">
                  {syncJob ? `Задание ${syncJob.id.slice(0, 8)} · попытка ${syncJob.attempts ?? 1}. Синхронизация продолжится на сервере, даже если закрыть страницу.` : 'HTTP-запрос только создаёт задание; получение профиля и журнала выполняется фоновым worker.'}
                </div>
              </div>
            )}

            {needsReauth && (
              <div className="capi-notice capi-notice-error" style={{ marginTop: 12 }}>
                <strong><IconError size={14} /> Frontier больше не принимает сохранённый токен</strong>
                <div className="capi-notice-hint">
                  {binding?.lastError || 'Refresh-токен Frontier живёт не дольше 25 дней.'} Подключите аккаунт заново,
                  выбрав платформу, где куплена игра:
                </div>
                {/*
                  Выбор платформы и при переподключении. Раньше кнопка молча
                  подставляла прежнюю платформу привязки: если вход был
                  frontier-учёткой без игры, «Переподключить» повторял ту же
                  ошибку до бесконечности.
                */}
                <div className="capi-platforms" style={{ marginTop: 8 }}>
                  {PLATFORMS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`capi-platform${platform === item.id ? ' capi-platform-active' : ''}`}
                      onClick={() => setPlatform(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {binding?.platform && (
                  <div className="capi-notice-hint" style={{ marginTop: 6 }}>
                    Прошлый токен был выдан платформой «{binding.platform}».
                    {binding.platform === 'frontier'
                      ? ' Если игра куплена в Steam/Epic — выберите её ниже и на странице Frontier войдите кнопкой платформы, а не почтой.'
                      : ''}
                  </div>
                )}
                <a href={`/api/capi/auth?platform=${platform}`} className="btn btn-orange" style={{ marginTop: 8 }}>
                  Переподключить
                </a>
              </div>
            )}

            {hasCapiError && (
              <div className="capi-notice capi-notice-partial" style={{ marginTop: 12 }}>
                <strong><IconWaiting size={14} /> Ошибка получения данных CAPI, не потеря авторизации</strong>
                <div className="capi-notice-hint">{binding?.lastError}</div>
                <div className="capi-notice-hint">
                  {frontierStoreEntitlementError
                    ? 'Сейчас токен подтверждён как Frontier Store, а CAPI не видит право на игру. Повтор синхронизации сам по себе платформу не изменит. Если игра куплена в Epic или Steam, ниже можно начать вход через точный магазин; текущие данные сайта не удаляются.'
                    : 'Сохранённые токены не удалены. Можно повторить синхронизацию и открыть диагностику без нового входа.'}
                </div>
                {frontierStoreEntitlementError && (
                  <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 4 }}>
                    <div className="capi-notice-hint" style={{ marginBottom: 8 }}>
                      Перед входом выйдите из старой сессии на auth.frontierstore.net или откройте приватное окно. На странице Frontier нажмите кнопку Epic/Steam, а не вход через почту. Это не отвязывает CAPI от сайта.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <a href="/api/capi/auth?platform=epic" className="btn btn-orange">Переподключить через Epic Games Store</a>
                      <a href="/api/capi/auth?platform=steam" className="btn">Переподключить через Steam</a>
                    </div>
                  </div>
                )}
              </div>
            )}

            {profileEmpty && !needsReauth && !hasCapiError && (
              <div className="capi-notice capi-notice-partial" style={{ marginTop: 12 }}>
                <strong><IconWaiting size={14} /> Привязка есть, данных пока нет</strong>
                <div className="capi-notice-hint">
                  Companion API отдаёт профиль только после входа в игру. Зайдите в Elite Dangerous
                  и нажмите «Синхронизировать».
                </div>
              </div>
            )}

            <div className={`capi-binding capi-binding-${binding?.status === 'conflict' ? 'warn' : 'ok'}`}>
              <strong style={{ color: binding?.status === 'conflict' || binding?.status === 'missing' ? 'var(--orange)' : 'var(--green)' }}>
                {binding?.status === 'conflict'
                  ? 'Проверка привязки: требуется внимание'
                  : binding?.status === 'missing'
                    ? 'Проверка привязки: имя Frontier не подтверждено'
                    : 'Проверка привязки: профиль связан'}
              </strong>
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                Сайт: {binding?.siteName || 'имя будет заполнено из Frontier'} · Frontier: {binding?.capiName || '—'}
              </div>
              {binding?.status === 'conflict' && (
                <div style={{ color: 'var(--orange)', marginTop: 4 }}>
                  Имя в профиле сайта не изменено автоматически. Проверьте ник в личном кабинете, чтобы URL досье и данные CAPI совпадали.
                </div>
              )}
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                Последняя синхронизация: {dateLabel(binding?.lastSyncedAt)}
                {binding?.accessExpired ? ' · токен доступа просрочен, обновится при синхронизации' : ''}
              </div>
            </div>
          </div>

          {syncReport && (
            <div className={`capi-notice ${syncJob?.status === 'failed' ? 'capi-notice-error' : 'capi-notice-success'}`} style={{ marginBottom: 20 }}>
              <strong>
                {syncJob?.status === 'failed' ? <IconError size={14} /> : <IconCheck size={14} />}
                {' '}{syncJob?.status === 'failed' ? 'Синхронизация завершилась с ошибкой' : 'Синхронизация завершена'}
              </strong>
              <div className="capi-notice-hint">
                {syncReport.cmdrName ? `CMDR ${syncReport.cmdrName}. ` : ''}
                Событий колонизации добавлено: {syncReport.eventsImported}
                {syncReport.eventsDuplicate ? `, повторов пропущено: ${syncReport.eventsDuplicate}` : ''}
                {' · '}{describeJournalStatus(syncReport.journalStatus)}
                {syncReport.durationMs != null ? ` · ${Math.round(syncReport.durationMs / 100) / 10} с` : ''}
              </div>
              {syncReport.warnings.length > 0 && (
                <ul className="capi-warnings">
                  {syncReport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              )}
              {syncReport.jobId && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>Диагностика этапов · задание {syncReport.jobId}</summary>
                  {syncReport.stageTimings?.length ? (
                    <ul className="capi-warnings">
                      {syncReport.stageTimings.map((timing, index) => (
                        <li key={`${timing.stage}-${index}`}>{syncStageLabel(timing.stage)}{timing.attempt ? ` (попытка ${timing.attempt})` : ''}: {Math.round(timing.durationMs / 10) / 100} с</li>
                      ))}
                    </ul>
                  ) : <div className="capi-notice-hint">Измерения этапов недоступны для этого завершения.</div>}
                </details>
              )}
            </div>
          )}

          <div className="card">
            <h3 className="capi-section-title">Ранги</h3>
            <div className="capi-rank-grid">
              {[
                { name: 'Combat', value: rankLabel(RANK_NAMES, profile?.combat_rank) },
                { name: 'Trade', value: rankLabel(RANK_NAMES, profile?.trade_rank) },
                { name: 'Explore', value: rankLabel(RANK_NAMES, profile?.explore_rank) },
                { name: 'CQC', value: rankLabel(RANK_NAMES, profile?.cqc_rank) },
                { name: 'Empire', value: rankLabel(EMPIRE_RANKS, profile?.empire_rank) },
                { name: 'Federation', value: rankLabel(FED_RANKS, profile?.federation_rank) },
              ].map((r) => (
                <div className="capi-rank-box" key={r.name}>
                  <div className="capi-rank-name">{r.name}</div>
                  <div className="capi-rank-value">{r.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 20 }}>
            <h3 className="capi-section-title">Текущее состояние</h3>
            <div className="stat-grid">
              <div className="stat-box">
                <div className="num" style={{ fontSize: 16 }}>{profile?.current_system || '—'}</div>
                <div className="lbl">Система</div>
              </div>
              <div className="stat-box">
                <div className="num" style={{ fontSize: 16 }}>{profile?.current_station || '—'}</div>
                <div className="lbl">Станция</div>
              </div>
              <div className="stat-box">
                <div className="num" style={{ fontSize: 16 }}>{profile?.current_ship || '—'}</div>
                <div className="lbl">Корабль</div>
              </div>
              <div className="stat-box">
                <div className="num">{profile?.credits?.toLocaleString('ru-RU') ?? '—'}</div>
                <div className="lbl">CR</div>
              </div>
              <div className="stat-box">
                <div className="num">{Array.isArray(profile?.ships) ? profile.ships.length : '—'}</div>
                <div className="lbl">Кораблей</div>
              </div>
            </div>
          </div>

          {networkError && (
            <div className="capi-notice capi-notice-error" style={{ marginTop: 16 }} role="alert">
              Проверка связи сервера с Frontier не выполнена: {networkError}
            </div>
          )}

          {networkCheck && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3 className="capi-section-title">Исходящая сеть сайта → Frontier CAPI</h3>
              <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
                Проверка выполняется с веб-сервера без CAPI-токена пользователя. Ответ HTTP 401/403 здесь ожидаем и означает, что DNS, HTTPS и узел Frontier доступны.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                {networkCheck.probes.map((probe) => {
                  const passed = probe.reachable && probe.https.ok;
                  const title = probe.host.startsWith('legacy-') ? 'Legacy CAPI' : 'Live CAPI';
                  return (
                    <div key={probe.host} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 12, background: 'rgba(0,0,0,.12)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <strong>{title}</strong>
                        <span style={{ color: passed ? 'var(--green)' : 'var(--red)', fontSize: 11, fontWeight: 700 }}>
                          {passed ? 'ДОСТУПЕН' : probe.dns.ok ? 'HTTPS НЕДОСТУПЕН' : 'DNS ОШИБКА'}
                        </span>
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
                        <div>DNS: {probe.dns.ok ? `OK · ${probe.dns.addressCount ?? 0} адрес(а) · ${probe.dns.durationMs} мс` : `${probe.dns.code || 'ошибка'} · ${probe.dns.error || 'не удалось разрешить имя'}`}</div>
                        <div>HTTPS: {probe.https.status ? `HTTP ${probe.https.status} · ${probe.https.durationMs} мс` : `${probe.https.code || 'ошибка'} · ${probe.https.error || 'ответ не получен'}`}</div>
                        <div style={{ overflowWrap: 'anywhere' }}>{probe.host}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 10, marginBottom: 0 }}>
                Проверено: {new Date(networkCheck.checkedAt).toLocaleString('ru-RU')} · лимит: DNS {networkCheck.timeoutMs.dns} мс, HTTPS {networkCheck.timeoutMs.https} мс.
              </p>
            </div>
          )}

          {diagnostics && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3 className="capi-section-title">Диагностика привязки</h3>
              <pre className="capi-diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre>
              <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8 }}>
                `config.redirectMatchesSite: false` — адрес возврата не совпадает с сайтом;
                `live.kind: maintenance` — Companion API временно недоступен;
                `live.reason: entitlement_unavailable` — OAuth сохранён, CAPI не подтвердил права на игру;
                `live.platform` — подтверждённая платформа, `live.detail` — ответ Frontier;
                `stored.looksEmpty: true` — профиль сохранён пустым, нужна синхронизация после входа в игру.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
