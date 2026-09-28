'use client';

import { useCallback, useEffect, useState } from 'react';
import { IconCheck, IconError, IconSync, IconWaiting } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';
import { capiReasonText, describeJournalStatus } from '@/lib/capi/messages';

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
};

type Diagnostics = {
  config: Record<string, unknown>;
  link: Record<string, unknown>;
  stored: Record<string, unknown>;
  live: Record<string, unknown> | null;
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
  const [platform, setPlatform] = useState('auto');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

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
    void fetchProfile();
  }, [fetchProfile]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setSyncReport(null);
    try {
      const res = await authFetch('/api/capi/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSyncReport({
          cmdrName: data.cmdrName ?? null,
          journalStatus: data.journalStatus ?? 'skipped',
          eventsImported: data.eventsImported ?? 0,
          eventsDuplicate: data.eventsDuplicate ?? 0,
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
        });
        await fetchProfile();
      } else {
        setError(data.needsReauth
          ? `${data.error || 'Frontier отклонил токен'} — подключите аккаунт заново.`
          : data.error || 'Синхронизация не удалась');
        if (Array.isArray(data.warnings) && data.warnings.length) {
          setSyncReport({ cmdrName: null, journalStatus: 'error', eventsImported: 0, eventsDuplicate: 0, warnings: data.warnings });
        }
      }
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Синхронизация не удалась');
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

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)' }}>Загрузка...</div>;

  // Привязка определяется токеном, а не кэшем профиля: строка в
  // capi_profiles может отсутствовать при живой связи (командир ещё не
  // заходил в игру, CAPI на обслуживании), и предлагать «подключить»
  // повторно в такой ситуации — вводить пилота в заблуждение.
  const linked = Boolean(binding?.linked);
  const needsReauth = linked && binding?.tokenActive === false;
  const profileEmpty = linked && (!profile || (profile.credits === null && !profile.current_system));

  return (
    <div style={{ padding: '24px 20px', maxWidth: 800 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 20 }}>
        FRONTIER CAPI
      </h2>

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
            Ошибка «Please Visit the store to purchase Elite: Dangerous» после входа означает, что выбрана не та платформа.
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
              <div className={needsReauth ? 'capi-status-broken' : 'capi-status-connected'}>
                <span className="capi-dot" style={{ background: needsReauth ? 'var(--red)' : 'var(--green)' }} />
                {needsReauth ? 'Требуется повторная авторизация' : 'Подключено'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-cyan" onClick={handleSync} disabled={syncing}>
                  <IconSync size={14} /> {syncing ? 'Синхр...' : 'Синхронизировать'}
                </button>
                <button className="btn" onClick={handleDiagnostics} disabled={diagLoading}>
                  {diagLoading ? 'Проверка...' : 'Диагностика'}
                </button>
                <button className="btn danger-btn" onClick={handleUnlink}>Отвязать</button>
              </div>
            </div>

            <p style={{ fontFamily: 'ui-monospace', fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
              CMDR: <span style={{ color: 'var(--orange)' }}>{profile?.cmdr_name || binding?.capiName || '—'}</span>
              {' | '}Обновлено: {dateLabel(profile?.last_updated)}
              {binding?.platform ? ` | Платформа: ${binding.platform}` : ''}
            </p>

            {needsReauth && (
              <div className="capi-notice capi-notice-error" style={{ marginTop: 12 }}>
                <strong><IconError size={14} /> Frontier больше не принимает сохранённый токен</strong>
                <div className="capi-notice-hint">
                  {binding?.lastError || 'Refresh-токен Frontier живёт не дольше 25 дней.'} Подключите аккаунт заново:
                </div>
                <a href={`/api/capi/auth?platform=${binding?.platform || 'auto'}`} className="btn btn-orange" style={{ marginTop: 8 }}>
                  Переподключить
                </a>
              </div>
            )}

            {profileEmpty && !needsReauth && (
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
            <div className="capi-notice capi-notice-success" style={{ marginBottom: 20 }}>
              <strong><IconCheck size={14} /> Синхронизация завершена</strong>
              <div className="capi-notice-hint">
                {syncReport.cmdrName ? `CMDR ${syncReport.cmdrName}. ` : ''}
                Событий колонизации добавлено: {syncReport.eventsImported}
                {syncReport.eventsDuplicate ? `, повторов пропущено: ${syncReport.eventsDuplicate}` : ''}
                {' · '}{describeJournalStatus(syncReport.journalStatus)}
              </div>
              {syncReport.warnings.length > 0 && (
                <ul className="capi-warnings">
                  {syncReport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
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

          {diagnostics && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3 className="capi-section-title">Диагностика привязки</h3>
              <pre className="capi-diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre>
              <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8 }}>
                `config.redirectMatchesSite: false` — адрес возврата не совпадает с сайтом;
                `live.kind: maintenance` — Companion API временно недоступен;
                `stored.looksEmpty: true` — профиль сохранён пустым, нужна синхронизация после входа в игру.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
