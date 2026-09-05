"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useI18n } from "@/lib/i18n/I18nContext";
import { DEFAULT_FOOTER } from "@/lib/siteFooter";
import ForumAdmin from "@/components/Forum/ForumAdmin";
import { MarkdownToolbar } from "@/components/Forum/MarkdownToolbar";
import { MarkdownRenderer } from "@/lib/markdown";
import RavenSyncTab from "@/components/Admin/RavenSyncTab";
import { IconSatellite } from "@/components/Icons";
import AdminComments from "./components/AdminComments";

const LANGS = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];
const LOCALE_FLAGS: Record<string, string> = { ru: '🇷🇺', en: '🇬🇧', de: '🇩🇪', it: '🇮🇹', ko: '🇰🇷', zh: '🇨🇳', ja: '🇯🇵' };

function emptyLangRecord(): Record<string, string> {
  return { ru: '', en: '', de: '', it: '', ko: '', zh: '', ja: '' };
}

function LangInputs({ label, values, onChange, textarea = false, placeholder }: {
  label: string;
  values: Record<string, string>;
  onChange: (lang: string, val: string) => void;
  textarea?: boolean;
  placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>{label}</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {LANGS.map((lang) => (
          <div key={lang}>
            <small style={{ color: '#9ca3af', fontSize: 11 }}>{LOCALE_FLAGS[lang]} {lang.toUpperCase()}</small>
            {textarea ? (
              <textarea
                style={{ width: '100%', minHeight: 80, resize: 'vertical' }}
                value={values[lang] ?? ''}
                onChange={(e) => onChange(lang, e.target.value)}
                placeholder={placeholder}
              />
            ) : (
              <input
                style={{ width: '100%' }}
                value={values[lang] ?? ''}
                onChange={(e) => onChange(lang, e.target.value)}
                placeholder={placeholder}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminPage() {
  const { t } = useI18n();
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<'content' | 'manage' | 'route' | 'forum' | 'news' | 'hubs' | 'sync' | 'comments'>('content');
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

  // Manifest multilang fields
  const [kickerLangs, setKickerLangs] = useState<Record<string, string>>(emptyLangRecord);
  const [title1Langs, setTitle1Langs] = useState<Record<string, string>>(emptyLangRecord);
  const [title2Langs, setTitle2Langs] = useState<Record<string, string>>(emptyLangRecord);
  const [manifestLangs, setManifestLangs] = useState<Record<string, string>>(emptyLangRecord);

  // Footer multilang fields
  const [footerCopyrightLangs, setFooterCopyrightLangs] = useState<Record<string, string>>(emptyLangRecord);
  const [footerDiscordLangs, setFooterDiscordLangs] = useState<Record<string, string>>(emptyLangRecord);
  const [footerEdsmLangs, setFooterEdsmLangs] = useState<Record<string, string>>(emptyLangRecord);
  const [footerInaraLangs, setFooterInaraLangs] = useState<Record<string, string>>(emptyLangRecord);

  const [saved, setSaved] = useState('');
  const [footerSaved, setFooterSaved] = useState('');

  // News multilang fields
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newsTitleLangs, setNewsTitleLangs] = useState<Record<string, string>>(emptyLangRecord);
  const [newsBodyLangs, setNewsBodyLangs] = useState<Record<string, string>>(emptyLangRecord);
  const newsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [currentCover, setCurrentCover] = useState<string | null>(null);
  const [nMsg, setNMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);

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
      const pick = (base: string) => {
        const rec: Record<string, string> = {};
        LANGS.forEach((l) => { rec[l] = (c as any)[`${base}_${l}`] ?? (c as any)[base] ?? ''; });
        return rec;
      };
      setKickerLangs(pick('kicker'));
      setTitle1Langs(pick('title1'));
      setTitle2Langs(pick('title2'));
      setManifestLangs(pick('manifest'));
      setFooterCopyrightLangs(pick('footer_copyright'));
      setFooterDiscordLangs(pick('footer_discord'));
      setFooterEdsmLangs(pick('footer_edsm'));
      setFooterInaraLangs(pick('footer_inara'));
    }
  };

  useEffect(() => { load(); }, []);

  const translateFields = useCallback(async (
    fields: Record<string, string>[],
    setters: ((rec: Record<string, string>) => void)[]
  ) => {
    setTranslating(true);
    try {
      const sourceLang = 'ru';
      const texts = fields.map((f) => f[sourceLang]).filter(Boolean);
      if (!texts.length) { setNMsg(t('admin.translationError') + ' ' + t('admin.pasteSystemsHint')); setTranslating(false); return; }

      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, sourceLang }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setters.forEach((setter, idx) => {
        const rec: Record<string, string> = {};
        LANGS.forEach((l) => { rec[l] = data.translations[l]?.[idx] ?? fields[idx][l] ?? ''; });
        setter(rec);
      });
      setNMsg(t('admin.translationSuccess'));
    } catch (e: any) {
      setNMsg(t('admin.translationError') + ' ' + e.message);
    } finally {
      setTranslating(false);
    }
  }, [t]);

  if (role === null) return <main className="card"><p>{t('common.loading')}</p></main>;
  if (!['admin', 'moderator'].includes(role))
    return <main className="card"><p>{t('admin.accessDenied')}</p></main>;

  const buildLangPayload = (base: string, rec: Record<string, string>) => {
    const payload: Record<string, string> = {};
    LANGS.forEach((l) => { payload[`${base}_${l}`] = rec[l]; });
    return payload;
  };

  const saveContent = async () => {
    const payload = {
      id: 1,
      ...buildLangPayload('kicker', kickerLangs),
      ...buildLangPayload('title1', title1Langs),
      ...buildLangPayload('title2', title2Langs),
      ...buildLangPayload('manifest', manifestLangs),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('site_content').upsert(payload);
    setSaved(error ? t('account.error') + ' ' + error.message : t('admin.savedAt') + ' ' + new Date().toLocaleTimeString('ru-RU'));
  };

  const saveFooter = async () => {
    const payload = {
      id: 1,
      ...buildLangPayload('footer_copyright', footerCopyrightLangs),
      ...buildLangPayload('footer_discord', footerDiscordLangs),
      ...buildLangPayload('footer_edsm', footerEdsmLangs),
      ...buildLangPayload('footer_inara', footerInaraLangs),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('site_content').upsert(payload);
    setFooterSaved(error ? t('account.error') + ' ' + error.message : t('admin.footerSavedAt') + ' ' + new Date().toLocaleTimeString('ru-RU'));
  };

  const resetNewsForm = () => {
    setEditingId(null);
    setNewsTitleLangs(emptyLangRecord());
    setNewsBodyLangs(emptyLangRecord());
    setCoverFile(null);
    setCurrentCover(null);
    setNMsg('');
  };

  const startEdit = (n: any) => {
    setEditingId(n.id);
    const pick = (base: string) => {
      const rec: Record<string, string> = {};
      LANGS.forEach((l) => { rec[l] = n[`${base}_${l}`] ?? n[base] ?? ''; });
      return rec;
    };
    setNewsTitleLangs(pick('title'));
    setNewsBodyLangs(pick('body'));
    setCurrentCover(n.cover_url ?? null);
    setCoverFile(null);
    setNMsg(t('admin.editingNews') + n.id);
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
    if (!newsTitleLangs.ru.trim() || !newsBodyLangs.ru.trim()) {
      setNMsg(t('admin.newsTitleLabel') + ' / ' + t('admin.newsBodyLabel'));
      return;
    }
    setBusy(true);
    let cover: string | null = currentCover;
    try { cover = await uploadCover(); } catch (e: any) {
      setBusy(false); setNMsg(t('admin.translationError') + ' ' + e.message); return;
    }
    const payload: any = {
      ...buildLangPayload('title', newsTitleLangs),
      ...buildLangPayload('body', newsBodyLangs),
      cover_url: cover,
      translation_status: 'completed',
    };
    const { error } = editingId
      ? await supabase.from('news').update(payload).eq('id', editingId)
      : await supabase.from('news').insert({ ...payload, author_id: me?.id });
    setBusy(false);
    if (error) { setNMsg(t('account.error') + ' ' + error.message); return; }
    setNMsg(editingId ? t('admin.saveChanges') : t('admin.publishNews'));
    resetNewsForm(); load();
  };

  const removeNews = async (id: number) => {
    if (!confirm(t('admin.confirmDeleteNews'))) return;
    await supabase.from('news').delete().eq('id', id);
    if (editingId === id) resetNewsForm(); load();
  };

  const setUserRole = async (id: string, r: string) => {
    await supabase.from('profiles').update({ role: r }).eq('id', id); load();
  };

  const addHub = async () => {
    const res = await fetch('/api/hubs/resolve?name=' + encodeURIComponent(system));
    const coords = await res.json();
    if (!res.ok) { alert(coords.error || t('admin.system')); return; }
    await supabase.from('hubs').insert({ name, system_name: coords.system_name, x: coords.x, y: coords.y, z: coords.z, segment_order: order });
    setName(''); setSystem(''); load();
  };

  const removeHub = async (id: number) => {
    if (!confirm(t('admin.confirmDeleteHub'))) return;
    await supabase.from('hubs').delete().eq('id', id); load();
  };

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
    if (!names.length) { setRouteMsg(t('admin.pasteSystemsHint')); return; }
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
    if (!toAdd.length) { setRouteMsg(`${t('admin.nothingToAdd')} ${skippedHub}, ${t('admin.alreadyInList')} ${skippedDup}.`); return; }
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
    if (errors.length) { setRouteMsg(t('account.error') + ' ' + errors[0]); return; }
    setRouteBulk('');
    setRouteMsg(`${t('admin.added')} ${toAdd.length}. ${t('admin.skippedHubs')} ${skippedHub}, ${t('admin.duplicates')} ${skippedDup}.`);
    load();
  };

  const removeRouteSystem = async (id: number) => {
    if (!confirm(t('admin.confirmDeleteSystem'))) return;
    await supabase.from('route_systems').delete().eq('id', id); load();
  };

  const updateRouteStatus = async (id: number, s: string) => {
    await supabase.from('route_systems').update({ status: s }).eq('id', id); load();
  };

  const updateRoutePointProgress = async (id: number, p: number) => {
    await supabase.from('route_systems').update({ progress: p }).eq('id', id); load();
  };

  const resolveRouteCoords = async () => {
    const needResolve = routeSystems.filter((r) => r.x == null || r.y == null || r.z == null);
    if (needResolve.length === 0) { setRouteMsg(t('admin.allHaveCoords')); return; }
    setRouteBusy(true);
    setRouteProgress(0);
    setRouteMsg(`${t('admin.coordsRequest')} ${needResolve.length} ${t('admin.systemsThisWillTake')}${Math.ceil(needResolve.length / 100)} ${t('admin.sec')}`);
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
      setRouteMsg(`${t('admin.updated')} ${updated} ${t('admin.of')} ${needResolve.length} (${t('admin.foundInEdsm')} ${data.resolved}). ${t('admin.reloadPage')}`);
      load();
    } catch (e: any) {
      setRouteMsg(t('account.error') + ' ' + e.message);
    } finally {
      setRouteBusy(false);
    }
  };

  const syncRouteProgress = async () => {
    if (!routeSystems.length) { setRouteMsg(t('admin.noSystemsToUpdate')); return; }
    setRouteBusy(true);
    setRouteProgress(0);
    setRouteMsg(t('admin.pollingRaven'));
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
      setRouteMsg(`${t('admin.updatedViaRaven')} ${updated} ${t('admin.of')} ${routeSystems.length}.`);
      load();
    } catch (e: any) {
      setRouteMsg(t('admin.ravenError') + ' ' + e.message);
    } finally {
      setRouteBusy(false);
    }
  };

  const deleteAllRouteSystems = async () => {
    if (!confirm(t('admin.confirmDeleteRoute'))) return;
    setRouteBusy(true);
    const { error } = await supabase.from('route_systems').delete().neq('id', 0);
    setRouteBusy(false);
    if (error) { setRouteMsg(t('account.error') + ' ' + error.message); return; }
    setRouteMsg(t('admin.deleteRoute'));
    load();
  };

  const filteredRouteAdmin = routeSystems.filter((r) => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return true;
    return String(r.system_name).toLowerCase().includes(q);
  });

  return (
    <main className="card">
      <h1>{t('admin.title')}</h1>
      <div className="tabs">
        <button className={tab === 'content' ? 'tab tab-active' : 'tab'} onClick={() => setTab('content')}>{t('admin.content')}</button>
        <button className={tab === 'news' ? 'tab tab-active' : 'tab'} onClick={() => setTab('news')}>{t('admin.news')}</button>
        <button className={tab === 'manage' ? 'tab tab-active' : 'tab'} onClick={() => setTab('manage')}>{t('admin.manage')}</button>
        <button className={tab === 'hubs' ? 'tab tab-active' : 'tab'} onClick={() => setTab('hubs')}>{t('admin.hubs')}</button>
        <button className={tab === 'route' ? 'tab tab-active' : 'tab'} onClick={() => setTab('route')}>{t('admin.route')}</button>
        <button className={tab === 'sync' ? 'tab tab-active' : 'tab'} onClick={() => setTab('sync')}><IconSatellite size={12} color="#e67e22" /> RavenColonial</button>
        <button className={tab === 'forum' ? 'tab tab-active' : 'tab'} onClick={() => setTab('forum')}>{t('admin.forum')}</button>
        <button className={tab === 'comments' ? 'tab tab-active' : 'tab'} onClick={() => setTab('comments')}>{t('admin.comments')}</button>
      </div>

      {tab === 'content' && (
        <div>
          <h2>{t('admin.manifestTitle')}</h2>
          <LangInputs label={t('admin.kickerLabel')} values={kickerLangs} onChange={(l, v) => setKickerLangs((p) => ({ ...p, [l]: v }))} />
          <LangInputs label={t('admin.title1Label')} values={title1Langs} onChange={(l, v) => setTitle1Langs((p) => ({ ...p, [l]: v }))} />
          <LangInputs label={t('admin.title2Label')} values={title2Langs} onChange={(l, v) => setTitle2Langs((p) => ({ ...p, [l]: v }))} />
          <LangInputs label={t('admin.manifestLabel')} values={manifestLangs} onChange={(l, v) => setManifestLangs((p) => ({ ...p, [l]: v }))} textarea />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={saveContent}>{t('admin.saveManifest')}</button>
            <button
              disabled={translating}
              onClick={() => translateFields([kickerLangs, title1Langs, title2Langs, manifestLangs], [setKickerLangs, setTitle1Langs, setTitle2Langs, setManifestLangs])}
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa' }}
            >
              {translating ? t('admin.translating') : '🌐 ' + t('admin.translateWithYandex')}
            </button>
            {saved && <span style={{ color: '#2ecc71' }}>{saved}</span>}
          </div>

          <h2 style={{ marginTop: 32 }}>{t('admin.footerTitle')}</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>{t('admin.emptyLinkHint')}</p>
          <LangInputs label={t('admin.copyrightLabel')} values={footerCopyrightLangs} onChange={(l, v) => setFooterCopyrightLangs((p) => ({ ...p, [l]: v }))} />
          <LangInputs label={t('admin.discordLabel')} values={footerDiscordLangs} onChange={(l, v) => setFooterDiscordLangs((p) => ({ ...p, [l]: v }))} placeholder="https://discord.gg/..." />
          <LangInputs label={t('admin.edsmLabel')} values={footerEdsmLangs} onChange={(l, v) => setFooterEdsmLangs((p) => ({ ...p, [l]: v }))} placeholder="https://www.edsm.net/" />
          <LangInputs label={t('admin.inaraLabel')} values={footerInaraLangs} onChange={(l, v) => setFooterInaraLangs((p) => ({ ...p, [l]: v }))} placeholder="https://inara.cz/" />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={saveFooter}>{t('admin.saveFooter')}</button>
            <button
              disabled={translating}
              onClick={() => translateFields([footerCopyrightLangs, footerDiscordLangs, footerEdsmLangs, footerInaraLangs], [setFooterCopyrightLangs, setFooterDiscordLangs, setFooterEdsmLangs, setFooterInaraLangs])}
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa' }}
            >
              {translating ? t('admin.translating') : '🌐 ' + t('admin.translateWithYandex')}
            </button>
            {footerSaved && <span style={{ color: footerSaved.startsWith(t('account.error')) ? '#e74c3c' : '#2ecc71' }}>{footerSaved}</span>}
          </div>
        </div>
      )}

      {tab === 'news' && (
        <div>
          <h2>{editingId ? t('admin.editingNews') + editingId : t('admin.newNews')}</h2>
          <LangInputs label={t('admin.newsTitleLabel')} values={newsTitleLangs} onChange={(l, v) => setNewsTitleLangs((p) => ({ ...p, [l]: v }))} placeholder={t('admin.newsTitlePlaceholder')} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>{t('admin.newsBodyLabel')}</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              {LANGS.map((lang) => (
                <div key={lang}>
                  <small style={{ color: '#9ca3af', fontSize: 11 }}>{LOCALE_FLAGS[lang]} {lang.toUpperCase()}</small>
                  <MarkdownToolbar
                    textareaRef={lang === 'ru' ? newsTextareaRef : undefined}
                    onChange={(val) => setNewsBodyLangs((p) => ({ ...p, [lang]: val }))}
                    getValue={() => newsBodyLangs[lang] ?? ''}
                  />
                  <textarea
                    ref={lang === 'ru' ? newsTextareaRef : undefined}
                    style={{ width: '100%', minHeight: 120 }}
                    value={newsBodyLangs[lang] ?? ''}
                    onChange={(e) => setNewsBodyLangs((p) => ({ ...p, [lang]: e.target.value }))}
                    placeholder={t('admin.newsBodyPlaceholder')}
                  />
                </div>
              ))}
            </div>
          </div>
          <label>{t('admin.coverLabel')}</label><br />
          <input type="file" accept="image/*" onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)} />
          {currentCover && !coverFile && (
            <span style={{ fontSize: 13, color: '#9ca3af' }}>
              {t('admin.currentCoverHint')} <a href="#" onClick={(e) => { e.preventDefault(); setCurrentCover(null); }} style={{ color: '#e67e22' }}>{t('admin.removeCover')}</a>
            </span>
          )}<br />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button disabled={busy} onClick={saveNews}>{busy ? t('admin.saving') : editingId ? t('admin.saveChanges') : t('admin.publishNews')}</button>
            {editingId && <button onClick={resetNewsForm}>{t('admin.cancelEdit')}</button>}
            <button
              disabled={translating || busy}
              onClick={() => translateFields([newsTitleLangs, newsBodyLangs], [setNewsTitleLangs, setNewsBodyLangs])}
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa' }}
            >
              {translating ? t('admin.translating') : '🌐 ' + t('admin.translateWithYandex')}
            </button>
            {nMsg && <span style={{ color: nMsg.includes(t('account.error')) ? '#e74c3c' : '#2ecc71' }}>{nMsg}</span>}
          </div>

          {news.map((n) => (
            <article key={n.id} className="news-item">
              {n.cover_url && <img src={n.cover_url} alt={n.title} className="news-cover" />}
              <div className="news-date">{new Date(n.published_at).toLocaleString('ru-RU')}{n.author?.cmdr_name ? ' · ' + n.author.cmdr_name : ''}</div>
              <h3>{n.title}</h3>
              <div className="news-body"><MarkdownRenderer content={n.body} /></div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => startEdit(n)}>{t('admin.editBtn')}</button>
                <button onClick={() => removeNews(n.id)}>{t('admin.deleteBtn')}</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {tab === 'manage' && (
        <div>
          <h2>{t('admin.users')}</h2>
          <table><thead><tr><th>{t('admin.email')}</th><th>{t('admin.cmdr')}</th><th>{t('admin.role')}</th></tr></thead>
            <tbody>{users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.cmdr_name ?? '—'}</td>
                <td><select value={u.role} onChange={(e) => setUserRole(u.id, e.target.value)}>
                  <option value="user">user</option><option value="moderator">moderator</option><option value="admin">admin</option>
                </select></td>
              </tr>
            ))}</tbody>
          </table>

          <h2 style={{ marginTop: 32 }}>{t('admin.deliveryModeration')}</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>{t('admin.cheaterHint')}</p>
        </div>
      )}

      {tab === 'hubs' && (
        <div>
          <h2>{t('admin.hubsTitle')}</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
            <input placeholder={t('admin.hubNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
            <input placeholder={t('admin.systemPlaceholder')} value={system} onChange={(e) => setSystem(e.target.value)} style={{ width: 200 }} />
            <input type="number" placeholder={t('admin.orderPlaceholder')} value={order} onChange={(e) => setOrder(+e.target.value)} style={{ width: 90 }} />
            <button onClick={addHub}>{t('admin.addHub')}</button>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>#</th><th>{t('admin.nameCol')}</th><th>{t('admin.systemPlaceholder')}</th><th>{t('admin.statusCol')}</th><th>{t('admin.coordsCol')}</th><th></th></tr></thead>
              <tbody>
                {hubs.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: "center", color: "#9ca3af" }}>{t('admin.noHubs')}</td></tr>
                )}
                {hubs.map((h) => (
                  <tr key={h.id}>
                    <td>{h.segment_order}</td>
                    <td><b>{h.name}</b></td>
                    <td>
                      <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(h.system_name)}`} target="_blank" rel="noopener noreferrer" style={{ color: "#e67e22", textDecoration: "none" }} title={t('admin.openInRaven')}>
                        {h.system_name} ↗
                      </a>
                    </td>
                    <td>
                      <select value={h.status} onChange={(e) => setHubStatus(h.id, e.target.value)}>
                        <option value="planned">{t('admin.statusPlanned')}</option>
                        <option value="building">{t('admin.statusBuilding')}</option>
                        <option value="done">{t('admin.statusDone')}</option>
                      </select>
                    </td>
                    <td>{h.x != null ? `${h.x.toFixed(1)} / ${h.y.toFixed(1)} / ${h.z.toFixed(1)}` : '—'}</td>
                    <td><button onClick={() => removeHub(h.id)} style={{ fontSize: 11, background: "#e74c3c" }}>{t('admin.deleteBtn')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'route' && (
        <div>
          <h2>{t('admin.routeSystems')}</h2>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>
            {t('admin.routeSystemsHint')} {t('admin.runSqlFirst')} <code>supabase/route_systems.sql</code> {t('admin.and')} <code>supabase/route_systems_coords.sql</code>.
          </p>
          <textarea value={routeBulk} onChange={(e) => setRouteBulk(e.target.value)} placeholder={`HIP 12345\nCol 285 Sector XX-X d1-2\n...`} style={{ minHeight: 180 }} />
          <button disabled={routeBusy} onClick={addRouteSystems}>{routeBusy ? t('admin.saving') : t('admin.addToRoute')}</button>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, marginBottom: 12 }}>
            <button disabled={routeBusy} onClick={resolveRouteCoords} style={{ fontSize: 12 }}>
              {routeBusy ? '⏳ ' + t('common.loading') : '📍 ' + t('admin.loadCoords')}
            </button>
            <button disabled={routeBusy} onClick={syncRouteProgress} style={{ fontSize: 12 }}>
              {routeBusy ? '⏳ ' + t('common.loading') : '⚡ ' + t('admin.syncProgress')}
            </button>
            <button disabled={routeBusy} onClick={() => setTab('sync')} style={{ fontSize: 12, background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa' }}>
              🔍 {t('admin.extendedSync')}
            </button>
            {role === 'admin' && (
              <button disabled={routeBusy} onClick={deleteAllRouteSystems} style={{ marginLeft: 'auto', background: '#e74c3c', fontSize: 12 }}>
                {routeBusy ? '⏳ ' + t('common.loading') : '🗑️ ' + t('admin.deleteRoute')}
              </button>
            )}
          </div>
          {routeBusy && (
            <div style={{ marginTop: 12, maxWidth: 420 }}>
              <div style={{ background: '#323538', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                <div style={{ width: routeProgress + '%', background: '#22c55e', height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>{routeProgress}% {t('admin.systemsThisWillTake').replace('систем… Это займёт ~', 'систем опрошено')}</div>
            </div>
          )}
          {routeMsg && (
            <p style={{ color: routeMsg.startsWith(t('account.error')) ? '#e74c3c' : '#2ecc71' }}>{routeMsg}</p>
          )}
          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            {t('admin.inList')} {routeSystems.length} · {t('admin.noCoords')} {routeSystems.filter((r) => r.x == null).length}
            {routeQuery.trim() ? ` · ${t('admin.shown')} ${filteredRouteAdmin.length}` : ''}
          </p>
          <input style={{ width: '100%', maxWidth: 420 }} placeholder={t('admin.searchRoute')} value={routeQuery} onChange={(e) => setRouteQuery(e.target.value)} />
          <div className="table-scroll">
            <table>
              <thead><tr><th>#</th><th>{t('admin.systemPlaceholder')}</th><th>{t('admin.statusCol')}</th><th>{t('admin.statusCol')}</th><th>{t('admin.coordsCol')}</th><th></th></tr></thead>
              <tbody>{filteredRouteAdmin.map((r) => (
                <tr key={r.id}>
                  <td>{r.sort_order}</td>
                  <td>
                    <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(r.system_name)}`} target="_blank" rel="noopener noreferrer" style={{ color: "#e67e22", textDecoration: "none" }} title={t('admin.openInRaven')}>
                      {r.system_name} ↗
                    </a>
                  </td>
                  <td>
                    <select value={r.status || 'planned'} onChange={(e) => updateRouteStatus(r.id, e.target.value)}>
                      <option value="planned">{t('admin.statusPlanned')}</option>
                      <option value="building">{t('admin.statusBuilding')}</option>
                      <option value="done">{t('admin.statusDone')}</option>
                    </select>
                  </td>
                  <td>
                    <input type="number" min={0} max={100} value={r.progress ?? 0} onChange={(e) => updateRoutePointProgress(r.id, +e.target.value)} style={{ width: 60 }} />
                  </td>
                  <td>{r.x != null ? `${r.x.toFixed(1)} / ${r.y.toFixed(1)} / ${r.z.toFixed(1)}` : '—'}</td>
                  <td><button onClick={() => removeRouteSystem(r.id)}>{t('admin.deleteBtn')}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'sync' && <RavenSyncTab />}
      {tab === 'forum' && <ForumAdmin />}
      {tab === 'comments' && (
        <div>
          <h2>{t('admin.commentModeration')}</h2>
          <AdminComments />
        </div>
      )}
    </main>
  );
}
