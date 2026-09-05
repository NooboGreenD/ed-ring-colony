"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nContext";
import { createSupabaseClient, authFetch } from "@/lib/supabaseClient";
import { startDiscordOAuthAction } from "../login/actions";
import { parseJournal } from "@/lib/journalParser";
import { avatarFromUser, hasProvider, nickFromUser } from "@/lib/authProfile";
import Link from "next/link";
import { SQUADRON_MEMBER_LIMIT } from "@/lib/squadronConstants";
import {
  AllegianceIcon,
  IconPower,
  IconActivity,
  IconHomeSystem,
  IconLanguage,
  IconTimezone,
  IconOpenRecruit,
  IconDiscord,
  IconWebsite,
  IconMembers,
  IconProjects,
  IconSquadron,
} from "@/components/Icons";

function getCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

const LS_KEY = 'sb-sgukfplhxdhmkqponwft-auth-token';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sgukfplhxdhmkqponwft.supabase.co';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function decodeJwt(token: string): any {
  try {
    const base64 = token.split('.')[1];
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function restoreSession(): Promise<any | null> {
  // 1. OAuth callback cookie (one-time)
  const sessionCookie = getCookie('sb-session');
  if (sessionCookie) {
    try {
      const session = JSON.parse(sessionCookie);
      const user = decodeJwt(session.access_token);
      localStorage.setItem(LS_KEY, JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: 'bearer',
        user: user,
      }));
      document.cookie = 'sb-session=; path=/; max-age=0; SameSite=Lax; Secure';
    } catch {
      /* ignore */
    }
  }

  // 2. Check localStorage and verify token via direct fetch
  const lsToken = localStorage.getItem(LS_KEY);
  if (!lsToken) return null;

  let session: any;
  try {
    session = JSON.parse(lsToken);
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': ANON_KEY,
      },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    /* ignore */
  }

  return null;
}

type Progress = { current: number; total: number; phase: string; pct: number };
type Tab = "profile" | "squadron" | "journals" | "tokens";

export default function AccountPage() {
  const { t, setLocale } = useI18n();
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [files, setFiles] = useState<FileList | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [cmdrEdit, setCmdrEdit] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [msg, setMsg] = useState("");
  const [mySquadron, setMySquadron] = useState<any>(null);
  const [squadronMsg, setSquadronMsg] = useState("");
  const [showCreateSquadron, setShowCreateSquadron] = useState(false);
  const [newSquadronName, setNewSquadronName] = useState("");
  const [newSquadronTag, setNewSquadronTag] = useState("");
  const [newSquadronDesc, setNewSquadronDesc] = useState("");
  const [tab, setTab] = useState<Tab>("profile");
  const [tokens, setTokens] = useState<any[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [tokenMsg, setTokenMsg] = useState("");
  const [language, setLanguage] = useState("ru");
  const [capiLinked, setCapiLinked] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const res = await authFetch('/api/capi/profile');
      if (res.ok) {
        const json = await res.json();
        setCapiLinked(!!json.profile);
      }
    })();
  }, [user]);

  const load = async () => {
    const u = await restoreSession();
    setUser(u);
    if (u) {
      const client = createSupabaseClient();
      const { data: p } = await client
        .from("profiles")
        .select("*")
        .eq("id", u.id)
        .maybeSingle();
      if (!p) {
        await fetch("/api/auth/ensure-profile", { method: "POST" });
        const again = await client
          .from("profiles")
          .select("*")
          .eq("id", u.id)
          .maybeSingle();
        setProfile(again.data);
        setCmdrEdit(again.data?.cmdr_name ?? "");
        setLanguage(again.data?.language ?? "ru");
        setLocale(again.data?.language ?? "ru");
      } else {
        setProfile(p);
        setCmdrEdit(p?.cmdr_name ?? "");
        setLanguage(p?.language ?? "ru");
        setLocale(p?.language ?? "ru");
      }
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const res = await authFetch(`/api/squadrons/my`);
      const json = await res.json();
      if (json.squadron) setMySquadron(json);
    })();
  }, [user]);

  if (!user) {
    return (
      <main className="card auth-card">
        <h1>{t('account.title')}</h1>
        <p className="auth-error">{t('account.loginRequired')}</p>
        <Link href="/login" className="btn btn-cyan">{t('account.login')}</Link>
      </main>
    );
  }

  const discordLinked = hasProvider(user, "discord");
  const emailLinked = hasProvider(user, "email");

  const saveCmdr = async () => {
    if (!user) return;
    setBusy(true);
    setMsg("");
    const client = createSupabaseClient();
    const { error } = await client
      .from("profiles")
      .update({ cmdr_name: cmdrEdit.trim() || null })
      .eq("id", user.id);
    setBusy(false);
    if (error) setMsg(t('account.error') + ' ' + error.message);
    else { setMsg(t('account.saved')); load(); }
  };

  const saveLanguage = async () => {
    if (!user) return;
    setBusy(true);
    setMsg("");
    const client = createSupabaseClient();
    const { error } = await client
      .from("profiles")
      .update({ language })
      .eq("id", user.id);
    setBusy(false);
    if (error) setMsg(t('account.error') + ' ' + error.message);
    else {
      setMsg(t('account.saved'));
      setLocale(language);
      load();
    }
  };

  const linkDiscord = async () => {
    setMsg("");
    try {
      const url = await startDiscordOAuthAction("link");
      if (url) window.location.href = url;
    } catch (err: any) {
      setMsg(err.message || t('account.discordLinkError'));
    }
  };

  const unlinkDiscord = async () => {
    setMsg("");
    const client = createSupabaseClient();
    const { data: { user: currentUser } } = await client.auth.getUser();
    if (!currentUser) return;
    const discordIdentity = (currentUser.identities ?? []).find((i: any) => i.provider === "discord");
    if (!discordIdentity) { setMsg(t('account.discordNotLinked')); return; }
    if ((currentUser.identities ?? []).length < 2) {
      setMsg(t('account.discordUnlinkNeedPassword'));
      return;
    }
    const { error } = await client.auth.unlinkIdentity(discordIdentity);
    if (error) setMsg(t('account.error') + ' ' + error.message);
    else { setMsg(t('account.discordUnlinked')); load(); }
  };

  const linkFrontier = () => {
    window.location.href = '/api/capi/auth';
  };

  const unlinkFrontier = async () => {
    setMsg("");
    const res = await authFetch('/api/capi/unlink', { method: 'DELETE' });
    if (res.ok) {
      setCapiLinked(false);
      setMsg(t('account.frontierUnlinked'));
    } else {
      const json = await res.json().catch(() => ({}));
      setMsg(t('account.error') + ' ' + (json.error || 'Unknown error'));
    }
  };

  const setPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPass.length < 6) {
      setMsg(t('account.passwordTooShort'));
      return;
    }
    if (newPass !== newPass2) {
      setMsg(t('account.passwordsMismatch'));
      return;
    }
    const client = createSupabaseClient();
    const { error } = await client.auth.updateUser({ password: newPass });
    setMsg(
      error
        ? error.message
        : t('account.passwordUpdated')
    );
    if (!error) {
      setNewPass("");
      setNewPass2("");
    }
  };

  const uploadAvatar = async (file: File) => {
    const client = createSupabaseClient();
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = user.id + "/" + Date.now() + "." + ext;
    const { error } = await client.storage
      .from("avatars")
      .upload(path, file, { upsert: true });
    if (error) {
      alert(error.message);
      return;
    }
    const { data } = client.storage.from("avatars").getPublicUrl(path);
    await client
      .from("profiles")
      .update({ avatar_url: data.publicUrl })
      .eq("id", user.id);
    setProfile((p: any) => ({ ...p, avatar_url: data.publicUrl }));
  };

  const upload = async () => {
    if (!files?.length) return;
    setBusy(true);
    setSummary(null);

    const lsToken = localStorage.getItem(LS_KEY);
    let accessToken = "";
    try {
      const s = JSON.parse(lsToken || '{}');
      accessToken = s.access_token;
    } catch { /* ignore */ }
    if (!accessToken) {
      setSummary({ error: t('account.sessionExpired') });
      setBusy(false);
      return;
    }

    const list = Array.from(files);
    const allDeliveries: any[] = [];
    let cmdr: string | null = null;
    const allStats = {
      eventsParsed: 0,
      cargoEvents: 0,
      deliveriesFound: 0,
      skippedNoSystem: 0,
      skippedMarketTrade: 0,
      skippedMining: 0,
      skippedEject: 0,
    };
    setProgress({ current: 0, total: list.length, phase: t('account.loadingSystems'), pct: 2 });
    const client = createSupabaseClient();
    const [{ data: hubsData }, { data: routeSystemsData }] = await Promise.all([
      client.from('hubs').select('system_name'),
      client.from('route_systems').select('id, system_name'),
    ]);
    const lookup = {
      hubs: new Set((hubsData || []).map((h: any) => String(h.system_name).toLowerCase())),
      routeSystems: new Map((routeSystemsData || []).map((r: any) => [String(r.system_name).toLowerCase(), r.id])),
    };

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setProgress({
        current: i + 1,
        total: list.length,
        phase: t('account.readingFile') + ' ' + f.name,
        pct: Math.round((i / list.length) * 90),
      });
      const text = await f.text();
      setProgress({
        current: i + 1,
        total: list.length,
        phase: t('account.parsingFile') + ' ' + f.name,
        pct: Math.round(((i + 0.5) / list.length) * 90),
      });
      const { cmdrName, deliveries, stats } = parseJournal(text, lookup);
      if (!cmdr && cmdrName) cmdr = cmdrName;
      allDeliveries.push(...deliveries);
      if (stats) {
        allStats.eventsParsed += stats.eventsParsed;
        allStats.cargoEvents += stats.cargoEvents;
        allStats.deliveriesFound += stats.deliveriesFound;
        allStats.skippedNoSystem += stats.skippedNoSystem;
        allStats.skippedMarketTrade += stats.skippedMarketTrade;
        allStats.skippedMining += stats.skippedMining;
        allStats.skippedEject += stats.skippedEject;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    const CHUNK = 500;
    const chunks = Math.max(1, Math.ceil(allDeliveries.length / CHUNK));
    let inserted = 0;
    let duplicates = 0;
    let eventsFound = 0;
    for (let c = 0; c < chunks; c++) {
      setProgress({
        current: list.length,
        total: list.length,
        phase: t('account.sendingBatch') + ' ' + (c + 1) + ' ' + t('account.of') + ' ' + chunks,
        pct: 90 + Math.round(((c + 1) / chunks) * 10),
      });
      const chunk = allDeliveries
        .slice(c * CHUNK, (c + 1) * CHUNK)
        .filter((d) => d.systemName && d.systemName.trim().length > 0)
        .map((d) => ({
          system_name: d.systemName,
          commodity: d.commodity,
          amount: d.amount,
          timestamp: d.timestamp,
          is_hub: d.isHub,
          route_system_id: d.routeSystemId,
        }));
      const res = await fetch("/api/logs/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ cmdr, deliveries: chunk }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSummary({ error: json.error || t('account.serverError') });
        setProgress(null);
        setBusy(false);
        return;
      }
      inserted += json.inserted ?? 0;
      duplicates += json.duplicates ?? 0;
      eventsFound += json.eventsFound ?? 0;
    }
    setSummary({
      ok: true,
      filesProcessed: list.length,
      eventsFound,
      inserted,
      duplicates,
      cmdr,
      parserStats: allStats,
    });
    setProgress(null);
    setBusy(false);
  };

  const loadTokens = async () => {
    const lsToken = localStorage.getItem(LS_KEY);
    let token = "";
    try {
      const s = JSON.parse(lsToken || '{}');
      token = s.access_token;
    } catch { return; }
    if (!token) return;
    const res = await fetch('/api/auth/tokens', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const json = await res.json();
    setTokens(json.tokens || []);
  };

  const createToken = async () => {
    const lsToken = localStorage.getItem(LS_KEY);
    let token = "";
    try {
      const s = JSON.parse(lsToken || '{}');
      token = s.access_token;
    } catch { return; }
    if (!token) return;
    setTokenMsg("");
    setGeneratedToken(null);
    const res = await fetch('/api/auth/tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: newTokenName || 'Colonial Helper Token' })
    });
    const json = await res.json();
    if (!res.ok) {
      setTokenMsg(json.error || t('account.error'));
      return;
    }
    setGeneratedToken(json.token);
    setNewTokenName("");
    loadTokens();
  };

  const revokeToken = async (id: string) => {
    if (!confirm(t('account.revokeTokenConfirm'))) return;
    const lsToken = localStorage.getItem(LS_KEY);
    let token = "";
    try {
      const s = JSON.parse(lsToken || '{}');
      token = s.access_token;
    } catch { return; }
    if (!token) return;
    await fetch('/api/auth/tokens', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    });
    loadTokens();
  };

  const allegianceIcon = (a: string | null) => {
    switch (a) {
      case "Alliance": return <AllegianceIcon allegiance="Alliance" size={12} color="#22c55e" />;
      case "Empire": return <AllegianceIcon allegiance="Empire" size={12} color="#a855f7" />;
      case "Federation": return <AllegianceIcon allegiance="Federation" size={12} color="#3b82f6" />;
      default: return <AllegianceIcon allegiance="Independent" size={12} color="#9ca3af" />;
    }
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case "active": return t('account.statusActive');
      case "recruiting": return t('account.statusRecruiting');
      case "closed": return t('account.statusClosed');
      case "disbanded": return t('account.statusDisbanded');
      default: return s;
    }
  };

  return (
    <div className="card" style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 24 }}>
        {avatarFromUser(user, profile) ? (
          <img src={avatarFromUser(user, profile)!} className="avatar" alt="avatar" style={{ width: 64, height: 64 }} />
        ) : (
          <div className="avatar" style={{ width: 64, height: 64, background: "#3a3d40" }} />
        )}
        <div>
          <div className="kicker">CMDR</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>{nickFromUser(user, profile)}</h1>
          <p style={{ margin: "4px 0", color: "#9ca3af", fontSize: 13 }}>{user.email}</p>
          <label className="btn btn-cyan" style={{ padding: "6px 14px", cursor: "pointer", fontSize: 11, marginTop: 6 }}>
            {t('account.changeAvatar')}
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
          </label>
        </div>
      </div>

      {msg && <p style={{ color: "#e67e22", fontSize: 14, marginBottom: 16 }}>{msg}</p>}

      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={tab === "profile" ? "tab tab-active" : "tab"} onClick={() => setTab("profile")}>{t('account.tabProfile')}</button>
        <button className={tab === "squadron" ? "tab tab-active" : "tab"} onClick={() => setTab("squadron")}>{t('account.tabSquadron')}</button>
        <button className={tab === "journals" ? "tab tab-active" : "tab"} onClick={() => setTab("journals")}>{t('account.tabJournals')}</button>
        <button className={tab === "tokens" ? "tab tab-active" : "tab"} onClick={() => { setTab("tokens"); loadTokens(); }}>{t('account.tabTokens')}</button>
      </div>

      {tab === "profile" && (
        <div>
          <h2 style={{ marginTop: 0 }}>{t('account.nickname')}</h2>
          <div className="auth-form" style={{ width: "100%", maxWidth: 420 }}>
            <label>{t('account.nickname')}<input value={cmdrEdit} onChange={(e) => setCmdrEdit(e.target.value)} /></label>
            <button type="button" onClick={saveCmdr} className="btn btn-cyan">{t('account.saveNickname')}</button>
          </div>

          <h2 style={{ marginTop: 32 }}>{t('account.language')}</h2>
          <div className="auth-form" style={{ width: "100%", maxWidth: 420 }}>
            <label>{t('account.language')}
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="ru">Русский</option>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
                <option value="it">Italiano</option>
                <option value="ko">한국어</option>
                <option value="zh">中文</option>
                <option value="ja">日本語</option>
              </select>
            </label>
            <button type="button" onClick={saveLanguage} className="btn btn-cyan">{t('account.saveLanguage')}</button>
          </div>

          <h2 style={{ marginTop: 32 }}>{t('account.loginMethods')}</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <span style={{ padding: "4px 12px", borderRadius: 2, fontSize: 12, background: emailLinked ? "rgba(34,197,94,0.12)" : "#2d3033", color: emailLinked ? "#22c55e" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>{emailLinked ? "✓ Email" : "○ Email"}</span>
            <span style={{ padding: "4px 12px", borderRadius: 2, fontSize: 12, background: discordLinked ? "rgba(88,101,242,0.12)" : "#2d3033", color: discordLinked ? "#5865F2" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>{discordLinked ? "✓ Discord" : "○ Discord"}</span>
          </div>

          {discordLinked ? (
            <button type="button" onClick={unlinkDiscord} className="btn danger-btn" style={{ fontSize: 12 }}>{t('account.unlinkDiscord')}</button>
          ) : (
            <button type="button" onClick={linkDiscord} className="btn btn-cyan" style={{ fontSize: 12 }}>{t('account.linkDiscord')}</button>
          )}

          <h2 style={{ marginTop: 32 }}>{t('account.frontierCapi')}</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <span style={{ padding: "4px 12px", borderRadius: 2, fontSize: 12, background: capiLinked ? "rgba(230,126,34,0.12)" : "#2d3033", color: capiLinked ? "#e67e22" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
              {capiLinked ? "✓ Frontier CAPI" : "○ Frontier CAPI"}
            </span>
          </div>

          {capiLinked ? (
            <button type="button" onClick={unlinkFrontier} className="btn danger-btn" style={{ fontSize: 12 }}>{t('account.unlinkFrontier')}</button>
          ) : (
            <button type="button" onClick={linkFrontier} className="btn btn-orange" style={{ fontSize: 12 }}>{t('account.linkFrontier')}</button>
          )}

          <h3 style={{ marginTop: 24 }}>{t('account.password')}</h3>
          <form className="auth-form" style={{ width: "100%", maxWidth: 420 }} onSubmit={setPassword}>
            <label>{t('account.newPassword')}<input type="password" autoComplete="new-password" value={newPass} onChange={(e) => setNewPass(e.target.value)} /></label>
            <label>{t('account.confirmPassword')}<input type="password" autoComplete="new-password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} /></label>
            <button type="submit" className="btn btn-cyan">{t('account.savePassword')}</button>
          </form>

          <div style={{ marginTop: 32 }}>
            <button onClick={() => { createSupabaseClient().auth.signOut(); localStorage.removeItem(LS_KEY); }} className="btn danger-btn">{t('account.logout')}</button>
          </div>
        </div>
      )}

      {tab === "squadron" && (
        <div>
          {!mySquadron && !showCreateSquadron && (
            <div style={{ textAlign: "center", padding: "48px 20px", color: "#9ca3af", border: "1px dashed #323538", borderRadius: 8 }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#1a1c1e", border: "2px solid #323538", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28 }}>—</div>
              <h3 style={{ color: '#eeeeee', margin: '0 0 8px', fontSize: 16 }}>{t('account.noSquadron')}</h3>
              <p style={{ margin: 0, fontSize: 13 }}>{t('account.noSquadronDesc')}</p>
              <button onClick={() => setShowCreateSquadron(true)} className="btn btn-orange" style={{ marginTop: 16 }}>{t('account.createSquadron')}</button>
              <Link href="/squadrons" className="btn btn-cyan" style={{ marginTop: 16, marginLeft: 8 }}>{t('account.findSquadron')}</Link>
            </div>
          )}

          {showCreateSquadron && (
            <div style={{ background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 20, maxWidth: 500 }}>
              <h3 style={{ margin: '0 0 16px', color: '#eeeeee' }}>{t('account.newSquadron')}</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <input placeholder={t('account.squadronNamePlaceholder')} value={newSquadronName} onChange={(e) => setNewSquadronName(e.target.value)} />
                <input placeholder={t('account.squadronTagPlaceholder')} value={newSquadronTag} onChange={(e) => setNewSquadronTag(e.target.value)} maxLength={10} />
                <textarea placeholder={t('account.squadronDescPlaceholder')} value={newSquadronDesc} onChange={(e) => setNewSquadronDesc(e.target.value)} style={{ minHeight: 60 }} className="bulk-textarea" />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={async () => {
                    const res = await authFetch('/api/squadrons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newSquadronName, tag: newSquadronTag || undefined, description: newSquadronDesc || undefined }) });
                    const json = await res.json();
                    if (!res.ok) { setSquadronMsg(json.error); return; }
                    setShowCreateSquadron(false); setNewSquadronName(''); setNewSquadronTag(''); setNewSquadronDesc(''); setSquadronMsg(''); setMySquadron(json);
                  }} className="btn btn-cyan">{t('account.create')}</button>
                  <button onClick={() => setShowCreateSquadron(false)}>{t('account.cancel')}</button>
                </div>
              </div>
              {squadronMsg && <p style={{ color: '#e67e22', fontSize: 13, marginTop: 8 }}>{squadronMsg}</p>}
            </div>
          )}

          {mySquadron && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 12, height: 48, borderRadius: 2, background: mySquadron.squadron.color, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase" }}>{mySquadron.squadron.tag ? `[${mySquadron.squadron.tag}]` : t('account.tabSquadron')}</div>
                    <h2 style={{ margin: "4px 0 0", color: mySquadron.squadron.color }}>{mySquadron.squadron.name}</h2>
                    {mySquadron.squadron.description && (<p style={{ color: "#9ca3af", marginTop: 6, maxWidth: 600, fontSize: 14, lineHeight: 1.6 }}>{mySquadron.squadron.description}</p>)}
                  </div>
                </div>
                <span style={{ padding: "4px 12px", borderRadius: 2, fontSize: 11, background: `${mySquadron.squadron.color}15`, color: mySquadron.squadron.color, fontWeight: 600, fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase" }}>{statusLabel(mySquadron.squadron.status)}</span>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", marginBottom: 20 }}>
                {mySquadron.squadron.allegiance && (<span style={badgeStyle} title={t('account.allegiance')}>{allegianceIcon(mySquadron.squadron.allegiance)} {mySquadron.squadron.allegiance}</span>)}
                {mySquadron.squadron.power && (<span style={{ ...badgeStyle, borderColor: "#e67e2255", color: "#f39c12" }} title={t('account.power')}><IconPower size={12} color="#f39c12" /> {mySquadron.squadron.power}</span>)}
                {mySquadron.squadron.activity_type && mySquadron.squadron.activity_type !== "Mixed" && (<span style={{ ...badgeStyle, borderColor: "#60a5fa55", color: "#60a5fa" }} title={t('account.activityType')}><IconActivity size={12} color="#60a5fa" /> {mySquadron.squadron.activity_type}</span>)}
                {mySquadron.squadron.home_system && (<span style={{ ...badgeStyle, borderColor: "#c4b5fd55", color: "#c4b5fd" }} title={t('account.homeSystem')}><IconHomeSystem size={12} color="#c4b5fd" /> {mySquadron.squadron.home_system}</span>)}
                {mySquadron.squadron.language && (<span style={badgeStyle} title={t('account.language')}><IconLanguage size={12} color="#9ca3af" /> {mySquadron.squadron.language}</span>)}
                {mySquadron.squadron.timezone && (<span style={badgeStyle} title={t('account.timezone')}><IconTimezone size={12} color="#9ca3af" /> {mySquadron.squadron.timezone}</span>)}
                {mySquadron.squadron.is_open_recruitment && (<span style={{ ...badgeStyle, borderColor: "#22c55e55", color: "#22c55e" }} title={t('account.recruitment')}><IconOpenRecruit size={12} color="#22c55e" />{t('account.openRecruitment')}</span>)}
                {mySquadron.squadron.discord_url && (<a href={mySquadron.squadron.discord_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#5865F255", color: "#5865F2", textDecoration: "none" }}><IconDiscord size={12} color="#5865F2" /> Discord</a>)}
                {mySquadron.squadron.website_url && (<a href={mySquadron.squadron.website_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#22c55e55", color: "#22c55e", textDecoration: "none" }}><IconWebsite size={12} color="#22c55e" />{t('account.website')}</a>)}
              </div>

              <div className="stat-grid" style={{ marginBottom: 24 }}>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.members?.length || 0}</div>
                  <div className="lbl">{t('account.pilots')}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>{t('account.of')} {mySquadron.squadron.member_limit || SQUADRON_MEMBER_LIMIT}</div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.projects?.length || 0}</div>
                  <div className="lbl">{t('account.projects')}</div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.ranks?.length || 0}</div>
                  <div className="lbl">{t('account.ranks')}</div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href={`/squadrons/${mySquadron.squadron.id}`} className="btn btn-cyan">{t('account.manageSquadron')}</Link>
                <button onClick={async () => {
                  if (!confirm(t('account.leaveSquadronConfirm'))) return;
                  await authFetch(`/api/squadrons/${mySquadron.squadron.id}/members`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: user.id }) });
                  setMySquadron(null);
                }} className="btn danger-btn">{t('account.leaveSquadron')}</button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "journals" && (
        <div>
          <h2 style={{ marginTop: 0 }}>{t('account.uploadJournals')}</h2>
          <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>{t('account.journalsDesc')}</p>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <label className="btn btn-cyan" style={{ padding: "8px 16px", cursor: "pointer", fontSize: 12 }}>
              {t('account.selectLogFiles')}
              <input type="file" multiple accept=".log" style={{ display: "none" }} onChange={(e) => setFiles(e.target.files)} />
            </label>
            <button disabled={busy || !files?.length} onClick={upload} className="btn btn-orange">{busy ? t('account.processing') : t('account.uploadAndParse')}</button>
            <a href="https://github.com/NooboGreenD/ed-ring-colony/releases" target="_blank" rel="noreferrer" className="btn btn-cyan" style={{ fontSize: 12 }}>{t('account.downloadColonialHelper')}</a>
          </div>

          {files && files.length > 0 && (<p style={{ fontSize: 12, color: '#9ca3af' }}>{t('account.filesSelected')} {files.length}</p>)}

          {progress && (
            <div style={{ margin: "14px 0" }}>
              <p style={{ color: '#9ca3af', fontSize: 13, fontFamily: 'ui-monospace, monospace', margin: '0 0 6px' }}>{t('account.file')} {progress.current} {t('account.of')} {progress.total} — {progress.phase}</p>
              <div style={{ background: "#323538", borderRadius: 8, height: 20 }}>
                <div style={{ width: progress.pct + "%", background: "#e67e22", height: "100%", borderRadius: 8, transition: "width 0.3s", textAlign: "center", fontSize: 11, lineHeight: "20px", color: "#1e2022", fontWeight: 700 }}>{progress.pct}%</div>
              </div>
            </div>
          )}

          {summary && (
            <div style={{ background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 16, marginTop: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>{t('account.result')}</h3>
              {summary.error ? (<p style={{ color: "#e74c3c" }}>{summary.error}</p>) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12 }}>
                  <span style={{ color: '#6b7280' }}>{t('account.files')}</span><span style={{ color: "#eeeeee" }}>{summary.filesProcessed}</span>
                  <span style={{ color: '#6b7280' }}>{t('account.events')}</span><span style={{ color: "#eeeeee" }}>{summary.eventsFound?.toLocaleString('ru')}</span>
                  <span style={{ color: '#6b7280' }}>{t('account.records')}</span><span style={{ color: "#22c55e" }}>{summary.inserted?.toLocaleString('ru')}</span>
                  <span style={{ color: '#6b7280' }}>{t('account.duplicatesLabel')}</span><span style={{ color: "#9ca3af" }}>{summary.duplicates?.toLocaleString('ru')}</span>
                  {summary.cmdr && (<><span style={{ color: '#6b7280' }}>{t('account.cmdrLabel')}</span><span style={{ color: "#eeeeee" }}>{summary.cmdr}</span></>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "tokens" && (
        <div>
          <h2 style={{ marginTop: 0 }}>{t('account.apiTokenTitle')}</h2>
          <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>{t('account.apiTokenDesc')}</p>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <input placeholder={t('account.tokenNamePlaceholder')} value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} style={{ maxWidth: 300 }} />
            <button onClick={createToken} className="btn btn-cyan" disabled={busy}>{t('account.createToken')}</button>
          </div>

          {generatedToken && (
            <div style={{ background: "#1a3a1a", border: "1px solid #2ecc71", borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <p style={{ color: '#2ecc71', fontSize: 12, margin: '0 0 8px', fontFamily: 'ui-monospace, monospace' }}>✓ {t('account.tokenCreated')}</p>
              <code style={{ display: "block", background: "#0d1f0d", padding: 12, borderRadius: 4, fontSize: 13, wordBreak: "break-all", color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>{generatedToken}</code>
              <button onClick={() => navigator.clipboard.writeText(generatedToken)} className="btn btn-cyan" style={{ marginTop: 8, fontSize: 11 }}>{t('account.copyToClipboard')}</button>
            </div>
          )}

          {tokenMsg && <p style={{ color: "#e67e22", fontSize: 14 }}>{tokenMsg}</p>}

          <h3 style={{ marginTop: 24, fontSize: 14 }}>{t('account.activeTokens')}</h3>
          {tokens.length === 0 ? (<p style={{ color: '#9ca3af', fontSize: 13 }}>{t('account.noTokens')}</p>) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tokens.map((token) => (
                <div key={token.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, background: "#25282b", border: "1px solid #323538", borderRadius: 4 }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#eeeeee" }}>{token.name}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                      {t('accountoken.created')} {new Date(token.created_at).toLocaleDateString('ru')}
                      {token.last_used_at && ` • {t('accountoken.used')} ${new Date(token.last_used_at).toLocaleDateString('ru')}`}
                      {token.is_revoked && <span style={{ color: '#e74c3c' }}> • {t('accountoken.revoked')}</span>}
                    </div>
                  </div>
                  {!token.is_revoked && (<button onClick={() => revokeToken(token.id)} className="btn danger-btn" style={{ fontSize: 11, padding: '6px 12px' }}>{t('accountoken.revoke')}</button>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const badgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 3,
  fontSize: 11,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid #323538",
  color: "#9ca3af",
  fontFamily: "ui-monospace, monospace",
  whiteSpace: "nowrap",
};
