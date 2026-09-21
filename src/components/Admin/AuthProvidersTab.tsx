'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/supabaseClient';
import type { AuthProviderMeta } from '@/lib/authProviders/registry';

type PublicSetting = { enabled: boolean; client_id: string; notes: string; updated_at: string | null; has_secret: boolean };
type Payload = {
  registry: AuthProviderMeta[];
  settings: Record<string, PublicSetting>;
  env: { gotrueAllowed: string[]; emailEnabled: boolean; serviceRole: boolean;
    vk: { client_id: boolean; client_secret: boolean }; frontier: { client_id: boolean; client_secret: boolean } };
  redirects: { gotrue: string; site: string; vk: string };
};
type Draft = { enabled: boolean; client_id: string; client_secret: string; clear_secret: boolean; notes: string };

const KIND_LABEL: Record<AuthProviderMeta['kind'], string> = {
  builtin: 'встроено', gotrue: 'Supabase Auth (GoTrue)', site: 'поток сайта', planned: 'план',
};
const KIND_COLOR: Record<AuthProviderMeta['kind'], string> = {
  builtin: '#9ca3af', gotrue: '#3ecf8e', site: '#0077ff', planned: '#e67e22',
};

const inputStyle = { width: '100%', background: '#141618', border: '1px solid #323538', color: '#e5e7eb', padding: '6px 8px', fontSize: 13, borderRadius: 2 } as const;

function Status({ meta, setting, env }: { meta: AuthProviderMeta; setting: PublicSetting; env: Payload['env'] }) {
  let text = ''; let color = '#9ca3af';
  if (meta.kind === 'gotrue') {
    const allowed = env.gotrueAllowed.includes(meta.gotrue!);
    if (allowed && setting.enabled) { text = 'кнопка показывается'; color = '#22c55e'; }
    else if (allowed) { text = 'разрешён в env, скрыт админом'; color = '#e67e22'; }
    else if (setting.enabled) { text = 'включён здесь, но нет в AUTH_OAUTH_PROVIDERS'; color = '#e67e22'; }
    else text = 'выключен';
  } else if (meta.id === 'vk') {
    const hasId = Boolean(setting.client_id) || env.vk.client_id;
    if (setting.enabled && hasId && env.serviceRole) { text = 'кнопка показывается'; color = '#22c55e'; }
    else if (setting.enabled && !hasId) { text = 'включён, но нет Client ID'; color = '#e67e22'; }
    else if (setting.enabled && !env.serviceRole) { text = 'нет SUPABASE_SERVICE_ROLE_KEY'; color = '#ef4444'; }
    else { text = 'скрыт (готов к включению)'; }
  } else if (meta.id === 'email') { text = env.emailEnabled ? 'регистрация по почте включена' : 'только вход/пароль (AUTH_EMAIL_ENABLED=false)'; }
  else if (meta.id === 'frontier') { text = env.frontier.client_id ? 'Client ID задан в env' : 'используется встроенный Client ID'; }
  else if (meta.kind === 'planned') { text = 'не реализовано — настройки сохраняются на будущее'; }
  return <span style={{ fontSize: 12, color }}>{text}</span>;
}

export default function AuthProvidersTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setMsg('');
    try {
      const res = await authFetch('/api/admin/auth-providers', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка загрузки');
      setData(json);
      const next: Record<string, Draft> = {};
      for (const meta of json.registry as AuthProviderMeta[]) {
        const s = json.settings[meta.id];
        next[meta.id] = { enabled: s.enabled, client_id: s.client_id, client_secret: '', clear_secret: false, notes: s.notes };
      }
      setDrafts(next);
    } catch (e: any) { setMsg(e.message || 'Ошибка загрузки'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (id: string, patch?: Partial<Draft>) => {
    const d = { ...drafts[id], ...patch };
    setBusy(id); setMsg('');
    try {
      const body: Record<string, unknown> = { enabled: d.enabled, client_id: d.client_id, notes: d.notes };
      if (d.clear_secret) body.clear_secret = true;
      else if (d.client_secret) body.client_secret = d.client_secret;
      const res = await authFetch('/api/admin/auth-providers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [id]: body }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Не сохранено');
      setData(prev => prev ? { ...prev, settings: json.settings } : prev);
      setDrafts(prev => ({ ...prev, [id]: { ...d, client_secret: '', clear_secret: false } }));
      setMsg('Сохранено. Кнопки на /login и /account обновятся при следующей загрузке страницы.');
    } catch (e: any) { setMsg(e.message || 'Не сохранено'); }
    finally { setBusy(null); }
  };

  if (!data) return <p>{msg || 'Загрузка…'}</p>;
  const visible = data.registry.filter(meta => showAll || meta.kind !== 'gotrue' || data.env.gotrueAllowed.includes(meta.gotrue!) || ['discord', 'google', 'github'].includes(meta.id));

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0 }}>Сервисы авторизации</h2>
      <label style={{ fontSize: 12, color: '#9ca3af' }}>
        <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> показать все известные ({data.registry.length})
      </label>
    </div>
    <p style={{ color: '#9ca3af', fontSize: 13, margin: '8px 0 12px' }}>
      Переключатель «показывать» управляет кнопками на страницах входа и профиля. Секреты хранятся только на сервере
      (для GoTrue-провайдеров они настраиваются в окружении Supabase Auth; поля здесь — памятка и заготовка).
      Секрет никогда не возвращается в браузер — показывается только факт его наличия.
    </p>
    <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12, display: 'grid', gap: 2 }}>
      <span>Redirect для GoTrue-провайдеров: <code>{data.redirects.gotrue}</code></span>
      <span>Redirect для VK ID: <code>{data.redirects.vk}</code></span>
      <span>Разрешены в AUTH_OAUTH_PROVIDERS: <code>{data.env.gotrueAllowed.join(', ') || '—'}</code></span>
    </div>
    {msg && <p role="status" style={{ color: msg.startsWith('Сохранено') ? '#22c55e' : '#ef4444', fontSize: 13 }}>{msg}</p>}

    <div style={{ display: 'grid', gap: 8 }}>
      {visible.map(meta => {
        const s = data.settings[meta.id];
        const d = drafts[meta.id];
        const canToggle = meta.kind === 'gotrue' || meta.kind === 'site';
        const expanded = open === meta.id;
        return <div key={meta.id} style={{ border: '1px solid #323538', borderRadius: 2, padding: '10px 12px', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 180 }}>{meta.label}</strong>
            <span style={{ fontSize: 11, padding: '2px 6px', border: `1px solid ${KIND_COLOR[meta.kind]}`, color: KIND_COLOR[meta.kind], borderRadius: 2 }}>{KIND_LABEL[meta.kind]}</span>
            <Status meta={meta} setting={s} env={data.env} />
            <span style={{ flex: 1 }} />
            {canToggle && <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={d.enabled} disabled={busy === meta.id}
                onChange={e => { const enabled = e.target.checked; setDrafts(p => ({ ...p, [meta.id]: { ...p[meta.id], enabled } })); void save(meta.id, { enabled }); }} /> показывать
            </label>}
            <button type="button" className="tab" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => setOpen(expanded ? null : meta.id)}>
              {expanded ? 'свернуть' : 'настройки'}
            </button>
          </div>
          {expanded && <div style={{ marginTop: 10, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <label style={{ fontSize: 12, color: '#9ca3af' }}>Client ID
              <input style={inputStyle} value={d.client_id} onChange={e => setDrafts(p => ({ ...p, [meta.id]: { ...p[meta.id], client_id: e.target.value } }))}
                placeholder={meta.id === 'vk' && data.env.vk.client_id ? 'задан в env (VK_ID_CLIENT_ID)' : ''} />
            </label>
            <label style={{ fontSize: 12, color: '#9ca3af' }}>Client Secret {s.has_secret && <span style={{ color: '#22c55e' }}>(сохранён)</span>}
              <input style={inputStyle} type="password" autoComplete="new-password" value={d.client_secret}
                onChange={e => setDrafts(p => ({ ...p, [meta.id]: { ...p[meta.id], client_secret: e.target.value, clear_secret: false } }))}
                placeholder={s.has_secret ? '•••••• (оставьте пустым, чтобы не менять)' : meta.id === 'vk' && data.env.vk.client_secret ? 'задан в env' : ''} />
              {s.has_secret && <label style={{ display: 'block', marginTop: 4 }}>
                <input type="checkbox" checked={d.clear_secret} onChange={e => setDrafts(p => ({ ...p, [meta.id]: { ...p[meta.id], clear_secret: e.target.checked } }))} /> удалить сохранённый секрет
              </label>}
            </label>
            <label style={{ fontSize: 12, color: '#9ca3af', gridColumn: '1 / -1' }}>Заметки
              <textarea style={{ ...inputStyle, minHeight: 48 }} value={d.notes} onChange={e => setDrafts(p => ({ ...p, [meta.id]: { ...p[meta.id], notes: e.target.value } }))} />
            </label>
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#9ca3af', display: 'grid', gap: 2 }}>
              <span>Переменные окружения: <code>{meta.env.join(', ')}</code></span>
              {meta.redirect === 'gotrue' && <span>Redirect URI у провайдера: <code>{data.redirects.gotrue}</code></span>}
              {meta.redirect === 'site-vk' && <span>Redirect URI у провайдера: <code>{data.redirects.vk}</code></span>}
              {meta.docs && <span>Консоль разработчика: <a href={meta.docs} target="_blank" rel="noreferrer">{meta.docs}</a></span>}
              {meta.note && <span>{meta.note}</span>}
              {s.updated_at && <span>Обновлено: {new Date(s.updated_at).toLocaleString('ru-RU')}</span>}
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-cyan" disabled={busy === meta.id} onClick={() => void save(meta.id)}>Сохранить</button>
              <button type="button" className="btn" disabled={busy === meta.id} onClick={() => void load()}>Отменить</button>
            </div>
          </div>}
        </div>;
      })}
    </div>
  </div>;
}
