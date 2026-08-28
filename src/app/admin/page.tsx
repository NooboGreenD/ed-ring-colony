"use client";
import { useEffect, useState, useRef } from "react";
import { supabase } from "@/lib/supabaseClient";
import { DEFAULT_FOOTER } from "@/lib/siteFooter";
import ForumAdmin from "@/components/Forum/ForumAdmin";
import { MarkdownToolbar } from "@/components/Forum/MarkdownToolbar";
import { MarkdownRenderer } from "@/lib/markdown";
import RavenSyncTab from "@/components/Admin/RavenSyncTab";
import { IconSatellite } from "@/components/Icons";

export default function AdminPage() {
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<'content' | 'manage' | 'route' | 'forum' | 'news' | 'hubs' | 'sync'>('content');
  const [users, setUsers] = useState<any[]>([]);
  const [hubs, setHubs] = useState<any[]>([]);
  const [routeSystems, setRouteSystems] = useState<any[]>([]);
  const [routeBulk, setRouteBulk] = useState('');
  const [routeQuery, setRouteQuery] = useState('');
  const [routeMsg, setRouteMsg] = useState('');
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeProgress, setRouteProgress] = useState(0);
  const [news, setNews] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [order, setOrder] = useState(1);
  const [kicker, setKicker] = useState('');
  const [title1, setTitle1] = useState('');
  const [title2, setTitle2] = useState('');
  const [manifest, setManifest] = useState('');
  const [footerCopyright, setFooterCopyright] = useState(DEFAULT_FOOTER.copyright);
  const [footerDiscord, setFooterDiscord] = useState(DEFAULT_FOOTER.discord);
  const [footerEdsm, setFooterEdsm] = useState(DEFAULT_FOOTER.edsm);
  const [footerInara, setFooterInara] = useState(DEFAULT_FOOTER.inara);
  const [saved, setSaved] = useState('');
  const [footerSaved, setFooterSaved] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nTitle, setNTitle] = useState('');
  const [nBody, setNBody] = useState('');
  const newsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [currentCover, setCurrentCover] = useState<string | null>(null);
  const [nMsg, setNMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setRole('guest'); return; }
    const { data: p } = await supabase.from('profiles').select('*').eq('id', u.user.id).single();
    setMe(p);
    setRole(p?.role ?? 'user');
    if (!['admin', 'moderator'].includes(p?.role ?? '')) return;
    const [{ data: us }, { data: hs }, { data: rs }, { data: c }, { data: nw }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('hubs').select('*').order('segment_order'),
      supabase.from('route_systems').select('*').order('sort_order').order('id'),
      supabase.from('site_content').select('*').eq('id', 1).maybeSingle(),
      supabase.from('news').select('*, author:profiles(cmdr_name)').order('published_at', { ascending: false }),
    ]);
    setUsers(us ?? []);
    setHubs(hs ?? []);
    setRouteSystems(rs ?? []);
    setNews(nw ?? []);
    if (c) {
      setKicker(c.kicker ?? '');
      setTitle1(c.title1 ?? '');
      setTitle2(c.title2 ?? '');
      setManifest(c.manifest ?? '');
      setFooterCopyright(c.footer_copyright ?? DEFAULT_FOOTER.copyright);
      setFooterDiscord(c.footer_discord ?? DEFAULT_FOOTER.discord);
      setFooterEdsm(c.footer_edsm ?? DEFAULT_FOOTER.edsm);
      setFooterInara(c.footer_inara ?? DEFAULT_FOOTER.inara);
    }
  };

  useEffect(() => { load(); }, []);

  if (role === null) return <main className="card"><p>Загрузка...</p></main>;
  if (!['admin', 'moderator'].includes(role))
    return <main className="card"><p>Доступ запрещён. Нужна роль moderator или admin.</p></main>;

  const saveContent = async () => {
    const { error } = await supabase.from('site_content').upsert({
      id: 1, kicker, title1, title2, manifest, updated_at: new Date().toISOString(),
    });
    setSaved(error ? 'Ошибка: ' + error.message : 'Сохранено в ' + new Date().toLocaleTimeString('ru-RU'));
  };

  const saveFooter = async () => {
    const { error } = await supabase.from('site_content').upsert({
      id: 1, kicker, title1, title2, manifest,
      footer_copyright: footerCopyright,
      footer_discord: footerDiscord.trim(),
      footer_edsm: footerEdsm.trim(),
      footer_inara: footerInara.trim(),
      updated_at: new Date().toISOString(),
    });
    setFooterSaved(error ? 'Ошибка: ' + error.message : 'Футер сохранён в ' + new Date().toLocaleTimeString('ru-RU'));
  };

  const resetNewsForm = () => {
    setEditingId(null); setNTitle(''); setNBody(''); setCoverFile(null); setCurrentCover(null);
  };
  const startEdit = (n: any) => {
    setEditingId(n.id); setNTitle(n.title); setNBody(n.body); setCurrentCover(n.cover_url ?? null);
    setCoverFile(null); setNMsg('Редактируется новость #' + n.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const uploadCover = async (): Promise<string | null> => {
    if (!coverFile) return currentCover;
    const ext = (coverFile.name.split('.').pop() || 'jpg').toLowerCase();
    const path = 'covers/' + Date.now() + '.' + ext;
    const { error } = await supabase.storage.from('news-covers').upload(path, coverFile);
    if (error) throw error;
    const { data } = supabase.storage.from('news-covers').getPublicUrl(path);
    return data.publicUrl;
  };
  const saveNews = async () => {
    if (!nTitle.trim() || !nBody.trim()) { setNMsg('Заполните заголовок и текст новости'); return; }
    setBusy(true);
    let cover: string | null = currentCover;
    try { cover = await uploadCover(); } catch (e: any) { setBusy(false); setNMsg('Ошибка загрузки обложки: ' + e.message); return; }
    const payload = { title: nTitle.trim(), body: nBody.trim(), cover_url: cover };
    const { error } = editingId
      ? await supabase.from('news').update(payload).eq('id', editingId)
      : await supabase.from('news').insert({ ...payload, author_id: me?.id });
    setBusy(false);
    if (error) { setNMsg('Ошибка: ' + error.message); return; }
    setNMsg(editingId ? 'Новость обновлена' : 'Новость опубликована');
    resetNewsForm(); load();
  };
  const removeNews = async (id: number) => {
    if (!confirm('Удалить новость?')) return;
    await supabase.from('news').delete().eq('id', id);
    if (editingId === id) resetNewsForm(); load();
  };

  const setUserRole = async (id: string, r: string) => {
    await supabase.from('profiles').update({ role: r }).eq('id', id); load();
  };
  const addHub = async () => {
    const res = await fetch('/api/hubs/resolve?name=' + encodeURIComponent(system));
    const coords = await res.json();
    if (!res.ok) { alert(coords.error || 'Система не найдена в EDSM'); return; }
    await supabase.from('hubs').insert({ name, system_name: coords.system_name, x: coords.x, y: coords.y, z: coords.z, segment_order: order });
    setName(''); setSystem(''); load();
  };
  const removeHub = async (id: number) => { if (!confirm('Удалить хаб?')) return; await supabase.from('hubs').delete().eq('id', id); load(); };
  const setHubStatus = async (id: number, s: string) => {
    await supabase.from('hubs').update({ status: s }).eq('id', id); load();
  };

  const parseRouteNames = (raw: string) => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const part of raw.split(/[\n\r,;]+/)) {
      const name = part.replace(/^["'\s]+|["'\s]+$/g, '').trim();
      if (!name || /^system(_name)?$/i.test(name) || /^#/.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); names.push(name);
    }
    return names;
  };

  const addRouteSystems = async () => {
    const names = parseRouteNames(routeBulk);
    if (!names.length) { setRouteMsg('Вставьте названия систем — по одному на строке или через запятую.'); return; }
    const hubSet = new Set(hubs.map((h) => String(h.system_name).toLowerCase()));
    const existing = new Set(routeSystems.map((r) => String(r.system_name).toLowerCase()));
    const toAdd: string[] = [];
    let skippedHub = 0, skippedDup = 0;
    for (const n of names) {
      const key = n.toLowerCase();
      if (hubSet.has(key)) { skippedHub++; continue; }
      if (existing.has(key)) { skippedDup++; continue; }
      existing.add(key); toAdd.push(n);
    }
    if (!toAdd.length) { setRouteMsg(`Нечего добавлять. Пропущено хабов: ${skippedHub}, уже в списке: ${skippedDup}.`); return; }
    setRouteBusy(true);
    let maxOrder = routeSystems.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0);
    const rows = toAdd.map((system_name) => ({ system_name, sort_order: ++maxOrder, status: 'planned', progress: 0 }));
    const chunk = 150;
    const errors: string[] = [];
    for (let i = 0; i < rows.length; i += chunk) {
      const { error } = await supabase.from('route_systems').insert(rows.slice(i, i + chunk));
      if (error) errors.push(error.message);
    }
    setRouteBusy(false);
    if (errors.length) { setRouteMsg('Ошибка: ' + errors[0]); return; }
    setRouteBulk('');
    setRouteMsg(`Добавлено: ${toAdd.length}. Пропущено хабов: ${skippedHub}, дубликатов: ${skippedDup}.`);
    load();
  };

  const removeRouteSystem = async (id: number) => { if (!confirm('Удалить систему из маршрута?')) return; await supabase.from('route_systems').delete().eq('id', id); load(); };

  const updateRouteStatus = async (id: number, s: string) => {
    await supabase.from('route_systems').update({ status: s }).eq('id', id); load();
  };

  const updateRoutePointProgress = async (id: number, p: number) => {
    await supabase.from('route_systems').update({ progress: p }).eq('id', id); load();
  };

  const resolveRouteCoords = async () => {
    const needResolve = routeSystems.filter((r) => r.x == null || r.y == null || r.z == null);
    if (needResolve.length === 0) { setRouteMsg('Все системы маршрута уже имеют координаты.'); return; }
    setRouteBusy(true);
    setRouteProgress(0);
    setRouteMsg(`Запрос координат EDSM для ${needResolve.length} систем… Это займёт ~${Math.ceil(needResolve.length / 100)} сек.`);
    try {
      const res = await fetch('/api/route/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: needResolve.map((r) => r.system_name) }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Сервер вернул не JSON (${contentType}): ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const entries = Object.entries(data.results) as [string, { x: number; y: number; z: number }][];
      const BATCH_DB = 100;
      let updated = 0;
      for (let i = 0; i < entries.length; i += BATCH_DB) {
        const chunk = entries.slice(i, i + BATCH_DB);
        const updates = chunk.map(([system_name, coords]) =>
          supabase.from('route_systems').update({ x: coords.x, y: coords.y, z: coords.z }).eq('system_name', system_name)
        );
        await Promise.all(updates);
        updated += chunk.length;
        setRouteProgress(Math.round((updated / entries.length) * 100));
      }
      setRouteMsg(`Обновлено: ${updated} из ${needResolve.length} (найдено в EDSM: ${data.resolved}). Перезагрузите страницу для обновления таблицы.`);
      load();
    } catch (e: any) {
      setRouteMsg('Ошибка: ' + e.message);
    } finally {
      setRouteBusy(false);
    }
  };

  const syncRouteProgress = async () => {
    if (!routeSystems.length) { setRouteMsg('Нет систем для обновления.'); return; }
    setRouteBusy(true);
    setRouteProgress(0);
    setRouteMsg('Опрос RavenColonial v2…');

    const batchSize = 5;
    let updated = 0;
    let processed = 0;

    try {
      for (let i = 0; i < routeSystems.length; i += batchSize) {
        const batch = routeSystems.slice(i, i + batchSize);
        const res = await fetch('/api/route/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: batch.map((r) => r.id) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        updated += data.updated || 0;
        processed += batch.length;
        setRouteProgress(Math.round((processed / routeSystems.length) * 100));
      }

      setRouteMsg(`Обновлено через RavenColonial v2: ${updated} из ${routeSystems.length}.`);
      load();
    } catch (e: any) {
      setRouteMsg('Ошибка RavenColonial: ' + e.message);
    } finally {
      setRouteBusy(false);
    }
  };

  const deleteAllRouteSystems = async () => {
    if (!confirm('Удалить ВСЕ системы маршрута? Это необратимо.')) return;
    setRouteBusy(true);
    const { error } = await supabase.from('route_systems').delete().neq('id', 0);
    setRouteBusy(false);
    if (error) { setRouteMsg('Ошибка: ' + error.message); return; }
    setRouteMsg('Все системы маршрута удалены.');
    load();
  };

  const filteredRouteAdmin = routeSystems.filter((r) => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return true;
    return String(r.system_name).toLowerCase().includes(q);
  });

  return (
    <main className="card">
      <h1>Админ-панель</h1>
      <div className="tabs">
        <button className={tab === 'content' ? 'tab tab-active' : 'tab'} onClick={() => setTab('content')}>Контент сайта</button>
        <button className={tab === 'news' ? 'tab tab-active' : 'tab'} onClick={() => setTab('news')}>Новости</button>
        <button className={tab === 'manage' ? 'tab tab-active' : 'tab'} onClick={() => setTab('manage')}>Управление</button>
        <button className={tab === 'hubs' ? 'tab tab-active' : 'tab'} onClick={() => setTab('hubs')}>Хабы</button>
        <button className={tab === 'route' ? 'tab tab-active' : 'tab'} onClick={() => setTab('route')}>Маршрут</button>
        <button className={tab === 'sync' ? 'tab tab-active' : 'tab'} onClick={() => setTab('sync')}><IconSatellite size={12} color="#e67e22" /> RavenColonial</button>
        <button className={tab === 'forum' ? 'tab tab-active' : 'tab'} onClick={() => setTab('forum')}>Форум</button>
      </div>

      {tab === 'content' && (
        <div>
          <h2>Манифест главной страницы</h2>
          <label>Служебная строка (kicker)</label><br />
          <input style={{ width: '100%' }} value={kicker} onChange={(e) => setKicker(e.target.value)} /><br />
          <label>Заголовок, строка 1</label><br />
          <input style={{ width: '100%' }} value={title1} onChange={(e) => setTitle1(e.target.value)} /><br />
          <label>Заголовок, строка 2</label><br />
          <input style={{ width: '100%' }} value={title2} onChange={(e) => setTitle2(e.target.value)} /><br />
          <label>Текст манифеста</label>
          <textarea value={manifest} onChange={(e) => setManifest(e.target.value)} />
          <button onClick={saveContent}>Сохранить манифест</button>
          {saved && <span style={{ marginLeft: 12, color: '#2ecc71' }}>{saved}</span>}

          <h2 style={{ marginTop: 32 }}>Футер главной страницы</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>Пустая ссылка не показывается.</p>
          <label>Копирайт</label><br />
          <input style={{ width: '100%' }} value={footerCopyright} onChange={(e) => setFooterCopyright(e.target.value)} /><br />
          <label>Discord</label><br />
          <input style={{ width: '100%' }} value={footerDiscord} onChange={(e) => setFooterDiscord(e.target.value)} placeholder="https://discord.gg/..." /><br />
          <label>EDSM</label><br />
          <input style={{ width: '100%' }} value={footerEdsm} onChange={(e) => setFooterEdsm(e.target.value)} placeholder="https://www.edsm.net/" /><br />
          <label>INARA</label><br />
          <input style={{ width: '100%' }} value={footerInara} onChange={(e) => setFooterInara(e.target.value)} placeholder="https://inara.cz/" /><br />
          <button onClick={saveFooter}>Сохранить футер</button>
          {footerSaved && <span style={{ marginLeft: 12, color: footerSaved.startsWith('Ошибка') ? '#e74c3c' : '#2ecc71' }}>{footerSaved}</span>}
        </div>
      )}

      {tab === 'news' && (
        <div>
          <h2>{editingId ? 'Редактирование новости #' + editingId : 'Новая новость'}</h2>
          <label>Заголовок</label><br />
          <input style={{ width: '100%' }} value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="Например: Хаб-07 достроен" /><br />
          <label>Текст новости</label>
          <MarkdownToolbar
            textareaRef={newsTextareaRef}
            onChange={setNBody}
            getValue={() => nBody}
          />
          <textarea
            ref={newsTextareaRef}
            value={nBody}
            onChange={(e) => setNBody(e.target.value)}
            placeholder="Что произошло..."
          />
          <label>Обложка (jpg/png, до 2 МБ)</label><br />
          <input type="file" accept="image/*" onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)} />
          {currentCover && !coverFile && (
            <span style={{ fontSize: 13, color: '#9ca3af' }}>
              Текущая обложка сохранится. <a href="#" onClick={(e) => { e.preventDefault(); setCurrentCover(null); }} style={{ color: '#e67e22' }}>Убрать обложку</a>
            </span>
          )}<br />
          <button disabled={busy} onClick={saveNews}>{busy ? 'Сохранение...' : editingId ? 'Сохранить изменения' : 'Опубликовать новость'}</button>
          {editingId && <button onClick={resetNewsForm}>Отменить редактирование</button>}
          {nMsg && <span style={{ marginLeft: 12, color: '#2ecc71' }}>{nMsg}</span>}

          {news.map((n) => (
            <article key={n.id} className="news-item">
              {n.cover_url && <img src={n.cover_url} alt={n.title} className="news-cover" />}
              <div className="news-date">{new Date(n.published_at).toLocaleString('ru-RU')}{n.author?.cmdr_name ? ' · ' + n.author.cmdr_name : ''}</div>
              <h3>{n.title}</h3>
              <div className="news-body"><MarkdownRenderer content={n.body} /></div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => startEdit(n)}>редактировать</button>
                <button onClick={() => removeNews(n.id)}>удалить</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {tab === 'manage' && (
        <div>
          <h2>Пользователи</h2>
          <table><thead><tr><th>E-mail</th><th>CMDR</th><th>Роль</th></tr></thead>
            <tbody>{users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.cmdr_name ?? '—'}</td>
                <td><select value={u.role} onChange={(e) => setUserRole(u.id, e.target.value)}>
                  <option value="user">user</option><option value="moderator">moderator</option><option value="admin">admin</option>
                </select></td>
              </tr>
            ))}</tbody>
          </table>

          <h2 style={{ marginTop: 32 }}>Модерация доставок</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>Читерские записи удаляются напрямую из таблицы deliveries через Supabase Studio.</p>
        </div>
      )}

      {tab === 'hubs' && (
        <div>
          <h2>Строительные хабы</h2>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
            <input placeholder="Название (например, Хаб-01)" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
            <input placeholder="Система" value={system} onChange={(e) => setSystem(e.target.value)} style={{ width: 200 }} />
            <input type="number" placeholder="Порядок" value={order} onChange={(e) => setOrder(+e.target.value)} style={{ width: 90 }} />
            <button onClick={addHub}>Добавить (координаты из EDSM)</button>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Название</th>
                  <th>Система</th>
                  <th>Статус</th>
                  <th>Координаты</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hubs.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "#9ca3af" }}>Хабов пока нет</td>
                  </tr>
                )}
                {hubs.map((h) => (
                  <tr key={h.id}>
                    <td>{h.segment_order}</td>
                    <td><b>{h.name}</b></td>
                    <td>
                      <a
                        href={`https://ravencolonial.com/#sys=${encodeURIComponent(h.system_name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#e67e22", textDecoration: "none" }}
                        title="Открыть в RavenColonial"
                      >
                        {h.system_name} ↗
                      </a>
                    </td>
                    <td>
                      <select value={h.status} onChange={(e) => setHubStatus(h.id, e.target.value)}>
                        <option value="planned">Запланирован</option>
                        <option value="building">Строительство</option>
                        <option value="done">Завершён</option>
                      </select>
                    </td>
                    <td>{h.x != null ? `${h.x.toFixed(1)} / ${h.y.toFixed(1)} / ${h.z.toFixed(1)}` : '—'}</td>
                    <td>
                      <button onClick={() => removeHub(h.id)} style={{ fontSize: 11, background: "#e74c3c" }}>удалить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'route' && (
        <div>
          <h2>Системы маршрута</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>
            Список систем кольца для вкладки «Маршрут» и для отображения на карте галактики.
            Можно вставить сразу сотни названий — по одному на строке. Совпадения с хабами пропускаются.
            Сначала выполните SQL из <code>supabase/route_systems.sql</code> и <code>supabase/route_systems_coords.sql</code>.
          </p>
          <textarea
            value={routeBulk}
            onChange={(e) => setRouteBulk(e.target.value)}
            placeholder={`HIP 12345\nCol 285 Sector XX-X d1-2\n...`}
            style={{ minHeight: 180 }}
          />
          <button disabled={routeBusy} onClick={addRouteSystems}>{routeBusy ? 'Добавление...' : 'Добавить в маршрут'}</button>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, marginBottom: 12 }}>
            <button disabled={routeBusy} onClick={resolveRouteCoords} style={{ fontSize: 12 }}>
              {routeBusy ? '⏳ Загрузка…' : '📍 Загрузить координаты EDSM'}
            </button>
            <button disabled={routeBusy} onClick={syncRouteProgress} style={{ fontSize: 12 }}>
              {routeBusy ? '⏳ Синхронизация…' : '⚡ Обновить прогресс (RavenColonial)'}
            </button>
            <button 
              disabled={routeBusy} 
              onClick={() => setTab('sync')} 
              style={{ fontSize: 12, background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa' }}
            >
              🔍 Расширенная синхронизация →
            </button>
            {role === 'admin' && (
              <button disabled={routeBusy} onClick={deleteAllRouteSystems} style={{ marginLeft: 'auto', background: '#e74c3c', fontSize: 12 }}>
                {routeBusy ? '⏳ Удаление…' : '🗑️ Удалить весь маршрут'}
              </button>
            )}
          </div>

          {routeBusy && (
            <div style={{ marginTop: 12, maxWidth: 420 }}>
              <div style={{ background: '#323538', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                <div style={{ width: routeProgress + '%', background: '#22c55e', height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>{routeProgress}% систем опрошено</div>
            </div>
          )}

          {routeMsg && (
            <p style={{ color: routeMsg.startsWith('Ошибка') ? '#e74c3c' : '#2ecc71' }}>{routeMsg}</p>
          )}

          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            В списке: {routeSystems.length} · без координат: {routeSystems.filter((r) => r.x == null).length}
            {routeQuery.trim() ? ` · показано: ${filteredRouteAdmin.length}` : ''}
          </p>
          <input style={{ width: '100%', maxWidth: 420 }} placeholder="Поиск по списку" value={routeQuery} onChange={(e) => setRouteQuery(e.target.value)} />
          <div className="table-scroll">
            <table>
              <thead><tr><th>#</th><th>Система</th><th>Статус</th><th>Прогресс</th><th>Координаты</th><th></th></tr></thead>
              <tbody>{filteredRouteAdmin.map((r) => (
                <tr key={r.id}>
                  <td>{r.sort_order}</td>
                  <td>
                    <a
                      href={`https://ravencolonial.com/#sys=${encodeURIComponent(r.system_name)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#e67e22", textDecoration: "none" }}
                      title="Открыть в RavenColonial"
                    >
                      {r.system_name} ↗
                    </a>
                  </td>
                  <td>
                    <select value={r.status || 'planned'} onChange={(e) => updateRouteStatus(r.id, e.target.value)}>
                      <option value="planned">Запланирован</option>
                      <option value="building">Строительство</option>
                      <option value="done">Завершён</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={r.progress ?? 0}
                      onChange={(e) => updateRoutePointProgress(r.id, +e.target.value)}
                      style={{ width: 60 }}
                    />
                  </td>
                  <td>{r.x != null ? `${r.x.toFixed(1)} / ${r.y.toFixed(1)} / ${r.z.toFixed(1)}` : '—'}</td>
                  <td><button onClick={() => removeRouteSystem(r.id)}>удалить</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'sync' && <RavenSyncTab />}
      {tab === 'forum' && <ForumAdmin />}
    </main>
  );
}
