"use client";
import { useEffect, useState, useCallback } from 'react';
import { supabase, authFetch } from '@/lib/supabaseClient';

// Design tokens from DESIGN.md
const COLORS = {
  bg: '#1e2022',
  panel: '#2a2d30',
  panelHover: '#323538',
  line: '#3a3d40',
  text: '#eeeeee',
  muted: '#9ca3af',
  orange: '#e67e22',
  orangeHover: '#f39c12',
  cyan: '#3498db',
  green: '#2ecc71',
  red: '#e74c3c',
};

type TabKey = 'dashboard' | 'monitor' | 'billing' | 'systems' | 'content' | 'users' | 'support' | 'backup' | 'auth';

interface Summary {
  success: boolean;
  checkedAt: string;
  overview: any;
  monitor: any;
  billing: any;
  lists: any;
  content: any;
  // /api/mobile/admin-summary returns rows from public.app_flags (or []).
  flags: Array<{ key: string; value: unknown; updated_at: string }>;
  health: any;
}

function formatBytes(b: number | null | undefined): string {
  if (b == null || !isFinite(b) || b < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(b, 1)) / Math.log(1024)));
  const s = b / Math.pow(1024, i);
  return `${s >= 100 ? s.toFixed(0) : s.toFixed(1)} ${units[i]}`;
}

function formatDate(v: string | null): string {
  if (!v) return '—';
  const t = Date.parse(v);
  return isFinite(t) ? new Date(t).toLocaleString('ru-RU') : '—';
}

function LevelPill({ level, label }: { level: string; label?: string }) {
  const map: Record<string, { color: string; bg: string; text: string }> = {
    healthy: { color: COLORS.green, bg: 'rgba(46,204,113,0.12)', text: 'OK' },
    warning: { color: '#f2b544', bg: 'rgba(242,181,68,0.12)', text: 'WARN' },
    critical: { color: COLORS.red, bg: 'rgba(231,76,60,0.12)', text: 'CRIT' },
    unknown: { color: COLORS.muted, bg: 'rgba(156,163,175,0.12)', text: '—' },
    current: { color: COLORS.green, bg: 'rgba(46,204,113,0.12)', text: 'CURRENT' },
    different: { color: '#f2b544', bg: 'rgba(242,181,68,0.12)', text: 'OUTDATED' },
  };
  const m = map[level] || map.unknown;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 99, border: `1px solid ${m.color}66`,
      background: m.bg, color: m.color,
      fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 1, fontWeight: 700, textTransform: 'uppercase'
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, boxShadow: `0 0 6px ${m.color}` }} />
      {label || m.text}
    </span>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: COLORS.panel,
      border: `1px solid ${COLORS.line}`,
      borderRadius: 4,
      padding: 16,
      marginBottom: 12,
      ...style
    }}>
      {children}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div style={{
      background: '#25282b',
      border: `1px solid ${COLORS.line}`,
      borderRadius: 2,
      padding: '12px 14px',
      flex: '1 1 140px',
      minWidth: 0,
    }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 20, fontWeight: 700, color: accent || COLORS.orange, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

export default function MobileAdminPage() {
  const [role, setRole] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (u?.user) {
        const { data: p } = await supabase.from('profiles').select('*').eq('id', u.user.id).single();
        setMe(p);
        setRole(p?.role ?? 'user');
        if (!['admin', 'moderator', 'support_manager'].includes(p?.role ?? '')) {
          setError('Доступ запрещён: требуется роль администратора');
          return;
        }
      } else {
        // preview
        const isPreview = typeof window !== 'undefined' && (window.location.hostname.includes('e2b.app') || window.location.hostname === 'localhost' || process.env.NODE_ENV !== 'production');
        if (isPreview) {
          setRole('admin');
          setMe({ cmdr_name: 'CMDR Admin (Preview)', role: 'admin' });
        } else {
          setRole('guest');
          setError('Требуется авторизация');
          return;
        }
      }

      const res = await authFetch(`/api/mobile/admin-summary?period=${period}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Не удалось загрузить данные');
      setSummary(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => load(true), 20000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'ui-monospace, monospace', padding: 24 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 36, height: 36, border: `2px solid ${COLORS.line}`, borderTopColor: COLORS.orange, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
          <div style={{ color: COLORS.muted, letterSpacing: 2, textTransform: 'uppercase', fontSize: 12 }}>Загрузка телеметрии...</div>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (error || role === 'guest') {
    return (
      <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.text, padding: 20 }}>
        <Card>
          <h2 style={{ margin: 0, color: COLORS.red, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' }}>Ошибка доступа</h2>
          <p style={{ color: COLORS.muted, marginTop: 8 }}>{error}</p>
          <a href="/login" style={{ display: 'inline-block', marginTop: 12, padding: '10px 18px', border: `1px solid ${COLORS.orange}`, color: COLORS.orange, borderRadius: 2, textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' }}>Войти</a>
        </Card>
      </div>
    );
  }

  const monitor = summary?.monitor;
  const billing = summary?.billing;
  const overview = summary?.overview;

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.text, fontFamily: "'Segoe UI', system-ui, sans-serif", paddingBottom: 80 }}>
      <style>{`
        *{box-sizing:border-box}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulseGlow{0%,100%{text-shadow:0 0 0 transparent}50%{text-shadow:0 0 10px ${COLORS.orange}88}}
        button{cursor:pointer}
        .no-scrollbar::-webkit-scrollbar{display:none}
        .no-scrollbar{scrollbar-width:none}
      `}</style>

      {/* TOPBAR */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: '#1a1c1e', borderBottom: `1px solid ${COLORS.line}`, padding: '0 16px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{ width: 28, height: 28, background: COLORS.orange, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#000', fontWeight: 800, fontSize: 14, fontFamily: 'ui-monospace, monospace' }}>E</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', color: COLORS.orange, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>ED RING COLONY</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: 1.5, color: COLORS.muted, textTransform: 'uppercase' }}>MOBILE ADMIN • {me?.cmdr_name || 'CMDR'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LevelPill level={summary?.health?.overall || 'unknown'} label={summary?.health?.overall || '—'} />
          <button onClick={() => load(true)} disabled={refreshing} style={{ width: 36, height: 36, border: `1px solid ${COLORS.line}`, background: 'transparent', borderRadius: 2, color: COLORS.text, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          </button>
        </div>
      </div>

      {/* TAB CONTENT */}
      <div style={{ padding: 12, maxWidth: 720, margin: '0 auto' }}>

        {tab === 'dashboard' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.text }}>Обзор системы</h2>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted }}>{summary?.checkedAt ? new Date(summary.checkedAt).toLocaleTimeString('ru-RU') : ''}</span>
            </div>

            {/* Health row */}
            <Card>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <LevelPill level={summary?.health?.app || 'unknown'} label={`APP: ${summary?.health?.app || '—'}`} />
                <LevelPill level={summary?.health?.database || 'unknown'} label={`DB: ${summary?.health?.database || '—'}`} />
                <LevelPill level={summary?.health?.disk || 'unknown'} label={`DISK: ${summary?.health?.disk || '—'}`} />
                <LevelPill level={summary?.health?.project || 'unknown'} label={`VER: ${summary?.health?.project || '—'}`} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                <Stat label="Командиры" value={overview?.profiles ?? '—'} />
                <Stat label="Хабы" value={overview?.hubs ?? '—'} />
                <Stat label="Маршрут" value={overview?.routeSystems ?? '—'} accent={COLORS.cyan} />
                <Stat label="Новости" value={overview?.news ?? '—'} accent={COLORS.cyan} />
                <Stat label="Тикеты OPEN" value={overview?.ticketsOpen ?? '—'} accent={overview?.ticketsOpen ? COLORS.red : COLORS.muted} />
                <Stat label="Галактика" value={overview?.galaxySystems ? `${(overview.galaxySystems/1000000).toFixed(1)}M` : '—'} accent={COLORS.green} />
              </div>
            </Card>

            {/* App & DB */}
            {monitor && (
              <>
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.orange }}>Приложение</h3>
                    <LevelPill level="healthy" label="ONLINE" />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    <div><span style={{ color: COLORS.muted }}>UPTIME</span><br /><span style={{ color: COLORS.text }}>{Math.floor((monitor.application?.uptimeSeconds||0)/3600)}ч {Math.floor(((monitor.application?.uptimeSeconds||0)%3600)/60)}м</span></div>
                    <div><span style={{ color: COLORS.muted }}>NODE</span><br /><span style={{ color: COLORS.text }}>{monitor.application?.nodeVersion || '—'}</span></div>
                    <div><span style={{ color: COLORS.muted }}>RSS</span><br /><span style={{ color: COLORS.text }}>{formatBytes(monitor.application?.memory?.rssBytes)}</span></div>
                    <div><span style={{ color: COLORS.muted }}>HEAP</span><br /><span style={{ color: COLORS.text }}>{formatBytes(monitor.application?.memory?.heapUsedBytes)}</span></div>
                  </div>
                </Card>

                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.orange }}>База данных</h3>
                    <LevelPill level={monitor.database?.status || 'unknown'} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    <div><span style={{ color: COLORS.muted }}>SIZE</span><br /><span style={{ color: COLORS.text }}>{formatBytes(monitor.database?.size?.databaseBytes)}</span></div>
                    <div><span style={{ color: COLORS.muted }}>LATENCY</span><br /><span style={{ color: COLORS.text }}>{monitor.database?.latencyMs != null ? `${monitor.database.latencyMs} ms` : '—'}</span></div>
                    <div style={{ gridColumn: '1 / -1' }}><span style={{ color: COLORS.muted }}>LARGEST TABLE</span><br /><span style={{ color: COLORS.text }}>{monitor.database?.size?.largest?.[0]?.name || '—'} — {formatBytes(monitor.database?.size?.largest?.[0]?.totalBytes)}</span></div>
                  </div>
                </Card>

                <Card>
                  <h3 style={{ margin: '0 0 10px', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.orange }}>Диск</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    <div><span style={{ color: COLORS.muted }}>USED</span><br /><span style={{ color: COLORS.text }}>{monitor.disk?.usedPercent != null ? `${monitor.disk.usedPercent}%` : '—'}</span></div>
                    <div><span style={{ color: COLORS.muted }}>FREE</span><br /><span style={{ color: COLORS.text }}>{formatBytes(monitor.disk?.availableBytes)}</span></div>
                  </div>
                  {monitor.disk?.usedPercent != null && (
                    <div style={{ marginTop: 10, height: 6, background: COLORS.line, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${monitor.disk.usedPercent}%`, height: '100%', background: monitor.disk.usedPercent > 90 ? COLORS.red : COLORS.orange, transition: 'width 0.5s' }} />
                    </div>
                  )}
                </Card>

                <Card>
                  <h3 style={{ margin: '0 0 10px', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.orange }}>Версия проекта</h3>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.6 }}>
                    <div><span style={{ color: COLORS.muted }}>CURRENT</span> <span style={{ color: COLORS.orange }}>{monitor.project?.currentSha?.slice(0,7) || '—'}</span> {monitor.project?.currentRef ? `(${monitor.project.currentRef})` : ''}</div>
                    <div><span style={{ color: COLORS.muted }}>UPSTREAM</span> <span style={{ color: COLORS.cyan }}>{monitor.project?.upstreamSha?.slice(0,7) || '—'}</span> [{monitor.project?.upstreamBranch}]</div>
                    <div><span style={{ color: COLORS.muted }}>AHEAD</span> <span style={{ color: COLORS.text }}>{monitor.project?.aheadBy ?? '—'} коммитов</span> • <span style={{ color: COLORS.muted }}>MIGRATIONS</span> <span style={{ color: monitor.project?.pendingMigrations?.length ? COLORS.red : COLORS.green }}>{monitor.project?.pendingMigrations?.length || 0}</span></div>
                    {monitor.project?.pendingMigrations?.length ? (
                      <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(231,76,60,0.08)', border: '1px solid rgba(231,76,60,0.3)', borderRadius: 2, color: COLORS.red, fontSize: 10 }}>{monitor.project.pendingMigrations.join(', ')}</div>
                    ) : null}
                  </div>
                </Card>
              </>
            )}

            {billing && (
              <Card>
                <h3 style={{ margin: '0 0 10px', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.orange }}>Биллинг — кратко</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <Stat label="Выручка" value={`${(billing.revenue?.total || 0).toLocaleString('ru-RU')} ₽`} accent={COLORS.green} />
                  <Stat label="Транзакций" value={billing.transactions?.total || '—'} />
                  <Stat label="Подписчики" value={billing.subscriptions?.active || '—'} accent={COLORS.cyan} />
                  <Stat label="ARPU" value={`${(billing.revenue?.arpu || 0).toFixed(0)} ₽`} />
                </div>
              </Card>
            )}
          </>
        )}

        {tab === 'monitor' && monitor && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Мониторинг сервера</h2>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Docker контейнеры</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {monitor.docker?.containers?.map((c: any) => (
                  <div key={c.service} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${c.state === 'running' && c.health !== 'unhealthy' ? COLORS.green : COLORS.red}`, borderRadius: 2 }}>
                    <div>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 700, color: COLORS.text }}>{c.service}</div>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted }}>{c.state} • {c.health} • restart {c.restartCount}</div>
                    </div>
                    <LevelPill level={c.state === 'running' && c.health !== 'unhealthy' ? 'healthy' : 'critical'} />
                  </div>
                )) || <div style={{ color: COLORS.muted, fontSize: 12 }}>Нет данных о контейнерах</div>}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Фоновые задачи</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {monitor.scheduler?.jobs?.map((j: any) => (
                  <div key={j.name} style={{ padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderRadius: 2 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <code style={{ fontSize: 12, color: COLORS.text }}>{j.name}</code>
                      <LevelPill level={j.status === 'healthy' ? 'healthy' : j.status === 'warning' ? 'warning' : 'unknown'} />
                    </div>
                    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted, marginTop: 4 }}>LAST {formatDate(j.lastSuccessAt)} • NEXT {formatDate(j.nextRunAt)}</div>
                    {j.lastError && <div style={{ marginTop: 6, padding: '4px 6px', background: 'rgba(242,181,68,0.08)', border: '1px solid rgba(242,181,68,0.3)', borderRadius: 2, color: '#f2b544', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>{j.lastError}</div>}
                  </div>
                )) || <div style={{ color: COLORS.muted, fontSize: 12 }}>Нет задач</div>}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Контент и переводы</h3>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.6 }}>
                <div><span style={{ color: COLORS.muted }}>TRANSLATE</span> {monitor.content?.translateConfigured ? <span style={{ color: COLORS.green }}>настроен</span> : <span style={{ color: COLORS.red }}>не настроен</span>}</div>
                <div><span style={{ color: COLORS.muted }}>PENDING</span> {monitor.content?.pendingTotal ?? '—'} статей</div>
                {monitor.content?.lastSync && (
                  <div><span style={{ color: COLORS.muted }}>LAST SYNC</span> {formatDate(monitor.content.lastSync.at)} • {monitor.content.lastSync.status} • +{monitor.content.lastSync.newCount ?? 0}</div>
                )}
                {monitor.content?.queue?.map((q: any) => (
                  <div key={q.table}><span style={{ color: COLORS.muted }}>{q.table}</span> {q.pending ?? '—'} в очереди</div>
                ))}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Размер БД — топ таблиц</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {monitor.database?.size?.largest?.map((t: any) => {
                  const max = monitor.database.size.largest[0]?.totalBytes || 1;
                  const pct = Math.round((t.totalBytes / max) * 100);
                  return (
                    <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                      <div>
                        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name} <span style={{ color: COLORS.muted, fontSize: 9 }}>{t.kind}</span></div>
                        <div style={{ height: 4, background: COLORS.line, borderRadius: 2, marginTop: 4 }}><div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.orange})` }} /></div>
                      </div>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted, textAlign: 'right' }}>{formatBytes(t.totalBytes)}<br />{t.liveRows != null ? `${t.liveRows.toLocaleString()} rows` : ''}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </>
        )}

        {tab === 'billing' && billing && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {(['7d','30d','90d'] as const).map(p => (
                <button key={p} onClick={() => setPeriod(p)} style={{ flex: 1, padding: '8px', background: period===p ? 'rgba(230,126,34,0.12)' : 'transparent', border: `1px solid ${period===p ? COLORS.orange : COLORS.line}`, color: period===p ? COLORS.orange : COLORS.muted, borderRadius: 2, fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' }}>{p}</button>
              ))}
            </div>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Выручка и метрики</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Total Revenue" value={`${(billing.revenue?.total||0).toLocaleString()} ₽`} accent={COLORS.green} />
                <Stat label="Transactions" value={billing.transactions?.total || 0} />
                <Stat label="Avg Check" value={`${(billing.revenue?.avgCheck||0).toFixed(0)} ₽`} />
                <Stat label="ARPU" value={`${(billing.revenue?.arpu||0).toFixed(0)} ₽`} accent={COLORS.cyan} />
                <Stat label="Active Subs" value={billing.subscriptions?.active || 0} accent={COLORS.green} />
                <Stat label="Churn" value={`${(billing.subscriptions?.churnRate||0).toFixed(1)}%`} accent={COLORS.red} />
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Телеметрия проекта</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Пилоты" value={billing.telemetry?.totalRegisteredPilots || '—'} />
                <Stat label="Системы" value={billing.telemetry?.totalSystemsClaimed || '—'} />
                <Stat label="Постройки" value={billing.telemetry?.totalFacilitiesBuilt || '—'} accent={COLORS.green} />
                <Stat label="Тоннаж" value={billing.telemetry?.totalTonnageHauled ? `${(billing.telemetry.totalTonnageHauled/1000).toFixed(1)}k` : '—'} />
                <Stat label="Тикеты OPEN" value={billing.telemetry?.supportTicketsOpen || 0} accent={COLORS.red} />
                <Stat label="API Tokens" value={billing.telemetry?.apiTokensActive || '—'} accent={COLORS.cyan} />
              </div>
            </Card>

            {billing.topProducts && (
              <Card>
                <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Топ товары</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {billing.topProducts.slice(0,5).map((p: any, i: number) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderRadius: 2, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                      <span style={{ color: COLORS.text }}>{p.name || p.id}</span>
                      <span style={{ color: COLORS.muted }}>{p.sales || p.count} продаж</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}

        {tab === 'systems' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Системы и маршрут</h2>
            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Хабы ({summary?.lists?.hubs?.length || 0})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflowY: 'auto' }} className="no-scrollbar">
                {summary?.lists?.hubs?.map((h: any) => (
                  <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${h.status==='done' ? COLORS.green : h.status==='building' ? COLORS.orange : COLORS.cyan}`, borderRadius: 2 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</div>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted }}>{h.system_name} • #{h.segment_order}</div>
                    </div>
                    <LevelPill level={h.status==='done' ? 'healthy' : h.status==='building' ? 'warning' : 'unknown'} label={h.status} />
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Маршрут ({overview?.routeSystems || 0})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflowY: 'auto' }} className="no-scrollbar">
                {summary?.lists?.routeSystems?.map((r: any) => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderRadius: 2 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sort_order}. {r.system_name}</div>
                      <div style={{ height: 3, background: COLORS.line, borderRadius: 2, marginTop: 4 }}><div style={{ width: `${r.progress||0}%`, height: '100%', background: COLORS.orange }} /></div>
                    </div>
                    <div style={{ marginLeft: 8, fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted }}>{r.progress||0}%</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Галактика</h3>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.6 }}>
                <div><span style={{ color: COLORS.muted }}>TOTAL SYSTEMS</span> <span style={{ color: COLORS.text }}>{overview?.galaxySystems?.toLocaleString('ru-RU') || '—'}</span></div>
                <div style={{ marginTop: 8, color: COLORS.muted, fontSize: 11 }}>Каталог Spansh импортируется через Админка → Каталог систем. Полный дамп десятки ГБ, облако точек для карты.</div>
              </div>
            </Card>
          </>
        )}

        {tab === 'content' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Контент</h2>
            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Новости ({overview?.news || 0})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {summary?.lists?.recentNews?.map((n: any) => (
                  <div key={n.id} style={{ padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderLeft: `2px solid ${COLORS.orange}`, borderRadius: 2 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>{n.title}</div>
                    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: COLORS.muted, marginTop: 2 }}>{formatDate(n.published_at)} • {n.translation_status || '—'}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Форум и комментарии</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Темы" value={overview?.forumThreads || '—'} />
                <Stat label="Посты" value={overview?.forumPosts || '—'} />
                <Stat label="Комменты" value={overview?.comments || '—'} />
                <Stat label="Galnet" value={overview?.galnetPending || '—'} accent={COLORS.cyan} />
              </div>
            </Card>

            {summary?.content && (
              <Card>
                <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Site Content</h3>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.6, color: COLORS.muted }}>
                  <div><span style={{ color: COLORS.text }}>KICKER</span> {summary.content.kicker || '—'}</div>
                  <div><span style={{ color: COLORS.text }}>TITLE</span> {summary.content.title1 || ''} {summary.content.title2 || ''}</div>
                </div>
              </Card>
            )}
          </>
        )}

        {tab === 'users' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Пользователи и доступ</h2>
            <Card>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Всего" value={overview?.profiles || '—'} />
                <Stat label="API Tokens" value={overview?.apiTokens || '—'} accent={COLORS.cyan} />
              </div>
              <div style={{ marginTop: 12, padding: '10px', background: 'rgba(52,152,219,0.08)', border: '1px solid rgba(52,152,219,0.3)', borderRadius: 2, fontSize: 12, color: COLORS.muted }}>
                Управление ролями, аватарами и правами доступно в полной админке /admin → Управление. Здесь — только счётчики и быстрый доступ.
              </div>
              <a href="/admin?tab=manage" style={{ display: 'block', marginTop: 12, textAlign: 'center', padding: '10px', border: `1px solid ${COLORS.cyan}`, color: COLORS.cyan, borderRadius: 2, textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Открыть полную админку</a>
            </Card>
          </>
        )}

        {tab === 'support' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Техподдержка</h2>
            <Card>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Открытых" value={overview?.ticketsOpen || 0} accent={COLORS.red} />
                <Stat label="Всего" value={overview?.ticketsTotal || 0} />
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: COLORS.muted }}>Тикеты обрабатываются в Админка → Техподдержка. Мобильная панель показывает только сводку.</div>
              <a href="/admin?tab=support" style={{ display: 'block', marginTop: 12, textAlign: 'center', padding: '10px', border: `1px solid ${COLORS.orange}`, color: COLORS.orange, borderRadius: 2, textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Открыть тикеты</a>
            </Card>
          </>
        )}

        {tab === 'backup' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Бэкапы и обновления</h2>
            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Обновление проекта</h3>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.6 }}>
                <div>Текущая: <span style={{ color: COLORS.orange }}>{monitor?.project?.currentSha?.slice(0,7) || '—'}</span></div>
                <div>Upstream: <span style={{ color: COLORS.cyan }}>{monitor?.project?.upstreamSha?.slice(0,7) || '—'}</span> ({monitor?.project?.aheadBy ?? 0} новых)</div>
                <div>Updater: {monitor?.project?.updater?.connected ? <span style={{ color: COLORS.green }}>подключен</span> : <span style={{ color: COLORS.red }}>недоступен</span>} {monitor?.project?.updater?.active ? '• ACTIVE' : ''}</div>
                {monitor?.project?.pendingMigrations?.length ? <div style={{ color: COLORS.red, marginTop: 6 }}>Миграции: {monitor.project.pendingMigrations.join(', ')}</div> : <div style={{ color: COLORS.green, marginTop: 6 }}>Миграций нет</div>}
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Последние бэкапы</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {summary?.lists?.backupLog?.length ? summary.lists.backupLog.map((b: any) => (
                  <div key={b.id} style={{ padding: '8px 10px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderRadius: 2, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                    <div style={{ color: COLORS.text }}>{formatDate(b.fetched_at || b.created_at)} • {b.status}</div>
                    <div style={{ color: COLORS.muted, fontSize: 10 }}>{b.error_msg || `${b.articles_count || ''} статей`}</div>
                  </div>
                )) : <div style={{ color: COLORS.muted, fontSize: 12 }}>Нет логов бэкапа (проверьте таблицу app_flags)</div>}
              </div>
            </Card>
          </>
        )}

        {tab === 'auth' && (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' }}>Авторизация</h2>
            <Card>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, color: COLORS.orange, letterSpacing: 2, textTransform: 'uppercase' }}>Провайдеры</h3>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: COLORS.muted, lineHeight: 1.6 }}>
                <div>Настройка OAuth: Discord, VK ID, Yandex ID, Frontier CAPI</div>
                <div style={{ marginTop: 8 }}>Флаги из app_flags:</div>
                {summary?.flags?.slice(0,10).map((f: any) => (
                  <div key={f.key || f.id} style={{ padding: '4px 6px', background: '#25282b', border: `1px solid ${COLORS.line}`, borderRadius: 2, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: COLORS.text }}>{f.key || f.id}</span>
                    <span style={{ color: f.enabled ? COLORS.green : COLORS.muted }}>{String(f.value ?? f.enabled ?? '')}</span>
                  </div>
                ))}
              </div>
              <a href="/admin?tab=auth" style={{ display: 'block', marginTop: 12, textAlign: 'center', padding: '10px', border: `1px solid ${COLORS.orange}`, color: COLORS.orange, borderRadius: 2, textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Управление авторизацией</a>
            </Card>
          </>
        )}

      </div>

      {/* BOTTOM NAV */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#1a1c1e', borderTop: `1px solid ${COLORS.line}`, zIndex: 50, display: 'flex', overflowX: 'auto', padding: '0 4px', height: 64 }} className="no-scrollbar">
        {[
          { k: 'dashboard', label: 'Обзор', icon: '◧' },
          { k: 'monitor', label: 'Монитор', icon: '◍' },
          { k: 'billing', label: 'Биллинг', icon: '₿' },
          { k: 'systems', label: 'Системы', icon: '⬡' },
          { k: 'content', label: 'Контент', icon: '☰' },
          { k: 'users', label: 'Юзеры', icon: '👤' },
          { k: 'support', label: 'Поддержка', icon: '🎧' },
          { k: 'backup', label: 'Бэкапы', icon: '💾' },
          { k: 'auth', label: 'Auth', icon: '🔒' },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k as TabKey)} style={{
            flex: '0 0 auto',
            minWidth: 64,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
            background: tab===t.k ? 'rgba(230,126,34,0.12)' : 'transparent',
            border: 'none',
            borderTop: tab===t.k ? `2px solid ${COLORS.orange}` : '2px solid transparent',
            color: tab===t.k ? COLORS.orange : COLORS.muted,
            padding: '6px 10px',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 9,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{t.icon}</span>
            <span style={{ fontSize: 9 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
