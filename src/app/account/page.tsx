"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { parseJournal } from "@/lib/journalParser";
import { avatarFromUser, hasProvider, nickFromUser } from "@/lib/authProfile";
import { startDiscordOAuth } from "@/lib/discordOAuth";
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

type Progress = { current: number; total: number; phase: string; pct: number };
type Tab = "profile" | "squadron" | "journals" | "tokens";

export default function AccountPage() {
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

  const load = async () => {
    const { data } = await supabase.auth.getUser();
    let u = data.user;
    if (u && !(u.identities ?? []).length) {
      const { data: sess } = await supabase.auth.getSession();
      u = sess.session?.user ?? u;
    }
    setUser(u);
    if (u) {
      const { data: p } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", u.id)
        .maybeSingle();
      if (!p) {
        await fetch("/api/auth/ensure-profile", { method: "POST" });
        const again = await supabase
          .from("profiles")
          .select("*")
          .eq("id", u.id)
          .maybeSingle();
        setProfile(again.data);
        setCmdrEdit(again.data?.cmdr_name ?? "");
      } else {
        setProfile(p);
        setCmdrEdit(p?.cmdr_name ?? "");
      }
    }
  };

  useEffect(() => {
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: membership } = await supabase
        .from('squadron_members')
        .select('squadron_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!membership) return;
      const res = await fetch(`/api/squadrons/${membership.squadron_id}`);
      const json = await res.json();
      if (json.squadron) setMySquadron(json);
    })();
  }, [user]);

  if (!user)
    return (
      <div className="card" style={{ padding: 40, textAlign: "center" }}>
        <p>Сначала войдите на странице <a href="/login" style={{ color: "#e67e22" }}>/login</a></p>
      </div>
    );

  const discordLinked = hasProvider(user, "discord");
  const emailLinked = hasProvider(user, "email");

  const saveCmdr = async () => {
    const name = cmdrEdit.trim();
    if (!name) return;
    const { error } = await supabase
      .from("profiles")
      .update({ cmdr_name: name })
      .eq("id", user.id);
    setMsg(error ? error.message : "Никнейм сохранён.");
    if (!error) setProfile((p: any) => ({ ...p, cmdr_name: name }));
  };

  const linkDiscord = async () => {
    setMsg("");
    const { error } = await startDiscordOAuth(supabase, "link");
    if (error) setMsg(error);
  };

  const unlinkDiscord = async () => {
    const ident = (user.identities ?? []).find(
      (i: any) => i.provider === "discord"
    );
    if (!ident) return;
    if ((user.identities ?? []).length < 2) {
      setMsg(
        "Нельзя отвязать Discord — это единственный способ входа. Сначала задайте пароль."
      );
      return;
    }
    const { error } = await supabase.auth.unlinkIdentity(ident);
    setMsg(error ? error.message : "Discord отвязан.");
    if (!error) load();
  };

  const setPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPass.length < 6) {
      setMsg("Пароль должен быть не короче 6 символов.");
      return;
    }
    if (newPass !== newPass2) {
      setMsg("Пароли не совпадают.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPass });
    setMsg(
      error
        ? error.message
        : "Пароль обновлён. Теперь можно входить по email и паролю."
    );
    if (!error) {
      setNewPass("");
      setNewPass2("");
    }
  };

  const uploadAvatar = async (file: File) => {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = user.id + "/" + Date.now() + "." + ext;
    const { error } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true });
    if (error) {
      alert(error.message);
      return;
    }
    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    await supabase
      .from("profiles")
      .update({ avatar_url: data.publicUrl })
      .eq("id", user.id);
    setProfile((p: any) => ({ ...p, avatar_url: data.publicUrl }));
  };

  const upload = async () => {
    if (!files?.length) return;
    setBusy(true);
    setSummary(null);
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
    // Загружаем справочники хабов и систем маршрутов
    setProgress({ current: 0, total: list.length, phase: "Загрузка справочников систем", pct: 2 });
    const [{ data: hubsData }, { data: routeSystemsData }] = await Promise.all([
      supabase.from('hubs').select('system_name'),
      supabase.from('route_systems').select('id, system_name'),
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
        phase: "Чтение файла " + f.name,
        pct: Math.round((i / list.length) * 90),
      });
      const text = await f.text();
      setProgress({
        current: i + 1,
        total: list.length,
        phase: "Разбор " + f.name,
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
        phase: "Отправка пакета " + (c + 1) + " из " + chunks,
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmdr, deliveries: chunk }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSummary({ error: json.error || "Ошибка сервера" });
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

  // ── API Tokens ──
  const loadTokens = async () => {
    const sess = await supabase.auth.getSession();
    const token = sess.data.session?.access_token;
    if (!token) return;
    const res = await fetch('/api/auth/tokens', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const json = await res.json();
    setTokens(json.tokens || []);
  };

  const createToken = async () => {
    const sess = await supabase.auth.getSession();
    const token = sess.data.session?.access_token;
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
      setTokenMsg(json.error || 'Ошибка создания токена');
      return;
    }
    setGeneratedToken(json.token);
    setNewTokenName("");
    loadTokens();
  };

  const revokeToken = async (id: string) => {
    if (!confirm('Отозвать этот токен? Colonial Helper перестанет работать.')) return;
    const sess = await supabase.auth.getSession();
    const token = sess.data.session?.access_token;
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

  // ── Helpers для отображения эскадрильи ──
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
      case "active": return "Активна";
      case "recruiting": return "Набор";
      case "closed": return "Закрыта";
      case "disbanded": return "Расформирована";
      default: return s;
    }
  };

  return (
    <div className="card" style={{ width: "100%" }}>
      {/* Шапка профиля */}
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
            Сменить аватар
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
          </label>
        </div>
      </div>

      {msg && <p style={{ color: "#e67e22", fontSize: 14, marginBottom: 16 }}>{msg}</p>}

      {/* Вкладки */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={tab === "profile" ? "tab tab-active" : "tab"} onClick={() => setTab("profile")}>
          Профиль
        </button>
        <button className={tab === "squadron" ? "tab tab-active" : "tab"} onClick={() => setTab("squadron")}>
          Эскадрилья
        </button>
        <button className={tab === "journals" ? "tab tab-active" : "tab"} onClick={() => setTab("journals")}>
          Журналы
        </button>
        <button className={tab === "tokens" ? "tab tab-active" : "tab"} onClick={() => { setTab("tokens"); loadTokens(); }}>
          API Токен
        </button>
      </div>

      {/* ── TAB: Профиль ── */}
      {tab === "profile" && (
        <div>
          <h2 style={{ marginTop: 0 }}>Никнейм</h2>
          <div className="auth-form" style={{ width: "100%", maxWidth: 420 }}>
            <label>
              Никнейм / CMDR
              <input value={cmdrEdit} onChange={(e) => setCmdrEdit(e.target.value)} />
            </label>
            <button type="button" onClick={saveCmdr} className="btn btn-cyan">
              Сохранить
            </button>
          </div>

          <h2 style={{ marginTop: 32 }}>Способы входа</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <span style={{
              padding: "4px 12px", borderRadius: 2, fontSize: 12,
              background: emailLinked ? "rgba(34,197,94,0.12)" : "#2d3033",
              color: emailLinked ? "#22c55e" : "#9ca3af",
              fontFamily: "ui-monospace, monospace",
            }}>
              {emailLinked ? "✓ Email" : "○ Email"}
            </span>
            <span style={{
              padding: "4px 12px", borderRadius: 2, fontSize: 12,
              background: discordLinked ? "rgba(88,101,242,0.12)" : "#2d3033",
              color: discordLinked ? "#5865F2" : "#9ca3af",
              fontFamily: "ui-monospace, monospace",
            }}>
              {discordLinked ? "✓ Discord" : "○ Discord"}
            </span>
          </div>

          {discordLinked ? (
            <button type="button" onClick={unlinkDiscord} className="btn danger-btn" style={{ fontSize: 12 }}>
              Отвязать Discord
            </button>
          ) : (
            <button type="button" onClick={linkDiscord} className="btn btn-cyan" style={{ fontSize: 12 }}>
              Привязать Discord
            </button>
          )}

          <h3 style={{ marginTop: 24 }}>Пароль</h3>
          <form className="auth-form" style={{ width: "100%", maxWidth: 420 }} onSubmit={setPassword}>
            <label>
              Новый пароль
              <input type="password" autoComplete="new-password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
            </label>
            <label>
              Повтор пароля
              <input type="password" autoComplete="new-password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-cyan">Сохранить пароль</button>
          </form>

          <div style={{ marginTop: 32 }}>
            <button onClick={() => supabase.auth.signOut()} className="btn danger-btn">Выйти</button>
          </div>
        </div>
      )}

      {/* ── TAB: Эскадрилья ── */}
      {tab === "squadron" && (
        <div>
          {!mySquadron && !showCreateSquadron && (
            <div style={{ textAlign: "center", padding: "48px 20px", color: "#9ca3af", border: "1px dashed #323538", borderRadius: 8 }}>
              <div style={{
                width: 64, height: 64, borderRadius: "50%", background: "#1a1c1e",
                border: "2px solid #323538", display: "flex", alignItems: "center",
                justifyContent: "center", margin: "0 auto 16px", fontSize: 28,
              }}>
                —
              </div>
              <h3 style={{ color: "#eeeeee", margin: "0 0 8px", fontSize: 16 }}>Нет эскадрильи</h3>
              <p style={{ margin: 0, fontSize: 13 }}>Вы не состоите в эскадрилье. Создайте свою или примите приглашение.</p>
              <button onClick={() => setShowCreateSquadron(true)} className="btn btn-orange" style={{ marginTop: 16 }}>
                Создать эскадрилью
              </button>
              <Link href="/squadrons" className="btn btn-cyan" style={{ marginTop: 16, marginLeft: 8 }}>
                Найти эскадрилью
              </Link>
            </div>
          )}

          {showCreateSquadron && (
            <div style={{ background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 20, maxWidth: 500 }}>
              <h3 style={{ margin: "0 0 16px", color: "#eeeeee" }}>Новая эскадрилья</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <input placeholder="Название эскадрильи" value={newSquadronName} onChange={(e) => setNewSquadronName(e.target.value)} />
                <input placeholder="Тег [TAG] (опционально)" value={newSquadronTag} onChange={(e) => setNewSquadronTag(e.target.value)} maxLength={10} />
                <textarea placeholder="Описание..." value={newSquadronDesc} onChange={(e) => setNewSquadronDesc(e.target.value)} style={{ minHeight: 60 }} className="bulk-textarea" />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={async () => {
                    const res = await fetch('/api/squadrons', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: newSquadronName, tag: newSquadronTag || undefined, description: newSquadronDesc || undefined })
                    });
                    const json = await res.json();
                    if (!res.ok) { setSquadronMsg(json.error); return; }
                    setShowCreateSquadron(false);
                    setNewSquadronName('');
                    setNewSquadronTag('');
                    setNewSquadronDesc('');
                    setSquadronMsg('');
                    setMySquadron(json);
                  }} className="btn btn-cyan">Создать</button>
                  <button onClick={() => setShowCreateSquadron(false)}>Отмена</button>
                </div>
              </div>
              {squadronMsg && <p style={{ color: '#e67e22', fontSize: 13, marginTop: 8 }}>{squadronMsg}</p>}
            </div>
          )}

          {mySquadron && (
            <>
              {/* Шапка эскадрильи */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 12, height: 48, borderRadius: 2, background: mySquadron.squadron.color, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase" }}>
                      {mySquadron.squadron.tag ? `[${mySquadron.squadron.tag}]` : "Эскадрилья"}
                    </div>
                    <h2 style={{ margin: "4px 0 0", color: mySquadron.squadron.color }}>{mySquadron.squadron.name}</h2>
                    {mySquadron.squadron.description && (
                      <p style={{ color: "#9ca3af", marginTop: 6, maxWidth: 600, fontSize: 14, lineHeight: 1.6 }}>
                        {mySquadron.squadron.description}
                      </p>
                    )}
                  </div>
                </div>
                <span style={{
                  padding: "4px 12px", borderRadius: 2, fontSize: 11,
                  background: `${mySquadron.squadron.color}15`, color: mySquadron.squadron.color,
                  fontWeight: 600, fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase",
                }}>
                  {statusLabel(mySquadron.squadron.status)}
                </span>
              </div>

              {/* Бейджи параметров */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", marginBottom: 20 }}>
                {mySquadron.squadron.allegiance && (
                  <span style={badgeStyle} title="Принадлежность">
                    {allegianceIcon(mySquadron.squadron.allegiance)} {mySquadron.squadron.allegiance}
                  </span>
                )}
                {mySquadron.squadron.power && (
                  <span style={{ ...badgeStyle, borderColor: "#e67e2255", color: "#f39c12" }} title="Сила (Power)">
                    <IconPower size={12} color="#f39c12" /> {mySquadron.squadron.power}
                  </span>
                )}
                {mySquadron.squadron.activity_type && mySquadron.squadron.activity_type !== "Mixed" && (
                  <span style={{ ...badgeStyle, borderColor: "#60a5fa55", color: "#60a5fa" }} title="Тип активности">
                    <IconActivity size={12} color="#60a5fa" /> {mySquadron.squadron.activity_type}
                  </span>
                )}
                {mySquadron.squadron.home_system && (
                  <span style={{ ...badgeStyle, borderColor: "#c4b5fd55", color: "#c4b5fd" }} title="Домашняя система">
                    <IconHomeSystem size={12} color="#c4b5fd" /> {mySquadron.squadron.home_system}
                  </span>
                )}
                {mySquadron.squadron.language && (
                  <span style={badgeStyle} title="Язык">
                    <IconLanguage size={12} color="#9ca3af" /> {mySquadron.squadron.language}
                  </span>
                )}
                {mySquadron.squadron.timezone && (
                  <span style={badgeStyle} title="Часовой пояс">
                    <IconTimezone size={12} color="#9ca3af" /> {mySquadron.squadron.timezone}
                  </span>
                )}
                {mySquadron.squadron.is_open_recruitment && (
                  <span style={{ ...badgeStyle, borderColor: "#22c55e55", color: "#22c55e" }} title="Набор">
                    <IconOpenRecruit size={12} color="#22c55e" /> Свободный набор
                  </span>
                )}
                {mySquadron.squadron.discord_url && (
                  <a href={mySquadron.squadron.discord_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#5865F255", color: "#5865F2", textDecoration: "none" }}>
                    <IconDiscord size={12} color="#5865F2" /> Discord
                  </a>
                )}
                {mySquadron.squadron.website_url && (
                  <a href={mySquadron.squadron.website_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#22c55e55", color: "#22c55e", textDecoration: "none" }}>
                    <IconWebsite size={12} color="#22c55e" /> Сайт
                  </a>
                )}
              </div>

              {/* Статистика */}
              <div className="stat-grid" style={{ marginBottom: 24 }}>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.members?.length || 0}</div>
                  <div className="lbl">Пилотов</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                    из {mySquadron.squadron.member_limit || SQUADRON_MEMBER_LIMIT}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.projects?.length || 0}</div>
                  <div className="lbl">Проектов</div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: mySquadron.squadron.color }}>{mySquadron.ranks?.length || 0}</div>
                  <div className="lbl">Званий</div>
                </div>
              </div>

              {/* Действия */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href={`/squadrons/${mySquadron.squadron.id}`} className="btn btn-cyan">
                  Управление эскадрильей
                </Link>
                <button onClick={async () => {
                  if (!confirm('Покинуть эскадрилью?')) return;
                  await fetch(`/api/squadrons/${mySquadron.squadron.id}/members`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: user.id })
                  });
                  setMySquadron(null);
                }} className="btn danger-btn">
                  Покинуть
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── TAB: Журналы ── */}
      {tab === "journals" && (
        <div>
          <h2 style={{ marginTop: 0 }}>Загрузка журналов</h2>
          <p style={{ color: "#9ca3af", fontSize: 14, lineHeight: 1.6 }}>
            Основной способ — приложение Colonial Helper: вход тем же email и
            паролем, что на сайте. Включите «Следить за игрой», чтобы сдачи груза
            уходили автоматически. Ниже — запасной разбор Journal.*.log в браузере
            (Saved Games\Frontier Developments\Elite Dangerous).
          </p>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <label className="btn btn-cyan" style={{ padding: "8px 16px", cursor: "pointer", fontSize: 12 }}>
              Выбрать файлы .log
              <input type="file" multiple accept=".log" style={{ display: "none" }} onChange={(e) => setFiles(e.target.files)} />
            </label>
            <button disabled={busy || !files?.length} onClick={upload} className="btn btn-orange">
              {busy ? "Обработка..." : "Загрузить и разобрать"}
            </button>
            <a href="/ColonialHelper/index.html" target="_blank" rel="noreferrer" className="btn btn-cyan" style={{ fontSize: 12 }}>
              Открыть Colonial Helper
            </a>
          </div>

          {files && files.length > 0 && (
            <p style={{ fontSize: 12, color: "#9ca3af" }}>
              Выбрано файлов: {files.length}
            </p>
          )}

          {progress && (
            <div style={{ margin: "14px 0" }}>
              <p style={{ color: "#9ca3af", fontSize: 13, fontFamily: "ui-monospace, monospace", margin: "0 0 6px" }}>
                Файл {progress.current} из {progress.total} — {progress.phase}
              </p>
              <div style={{ background: "#323538", borderRadius: 8, height: 20 }}>
                <div style={{
                  width: progress.pct + "%", background: "#e67e22", height: "100%",
                  borderRadius: 8, transition: "width 0.3s", textAlign: "center",
                  fontSize: 11, lineHeight: "20px", color: "#1e2022", fontWeight: 700,
                }}>
                  {progress.pct}%
                </div>
              </div>
            </div>
          )}

          {summary && (
            <div style={{ background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 16, marginTop: 16 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Результат</h3>
              {summary.error ? (
                <p style={{ color: "#e74c3c" }}>{summary.error}</p>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12 }}>
                  <span style={{ color: "#6b7280" }}>Файлов:</span>
                  <span style={{ color: "#eeeeee" }}>{summary.filesProcessed}</span>
                  <span style={{ color: "#6b7280" }}>Событий:</span>
                  <span style={{ color: "#eeeeee" }}>{summary.eventsFound?.toLocaleString('ru')}</span>
                  <span style={{ color: "#6b7280" }}>Записей:</span>
                  <span style={{ color: "#22c55e" }}>{summary.inserted?.toLocaleString('ru')}</span>
                  <span style={{ color: "#6b7280" }}>Дубликатов:</span>
                  <span style={{ color: "#9ca3af" }}>{summary.duplicates?.toLocaleString('ru')}</span>
                  {summary.cmdr && (
                    <><span style={{ color: "#6b7280" }}>CMDR:</span><span style={{ color: "#eeeeee" }}>{summary.cmdr}</span></>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* ── TAB: API Токен ── */}
      {tab === "tokens" && (
        <div>
          <h2 style={{ marginTop: 0 }}>API Токен для Colonial Helper</h2>
          <p style={{ color: "#9ca3af", fontSize: 14, lineHeight: 1.6 }}>
            Создайте токен для автономного приложения Colonial Helper. 
            Токен показывается только один раз — сохраните его сразу.
          </p>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <input 
              placeholder="Название токена (опционально)" 
              value={newTokenName} 
              onChange={(e) => setNewTokenName(e.target.value)}
              style={{ maxWidth: 300 }}
            />
            <button onClick={createToken} className="btn btn-cyan" disabled={busy}>
              Создать токен
            </button>
          </div>

          {generatedToken && (
            <div style={{ background: "#1a3a1a", border: "1px solid #2ecc71", borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <p style={{ color: "#2ecc71", fontSize: 12, margin: "0 0 8px", fontFamily: "ui-monospace, monospace" }}>
                ✓ Токен создан! Скопируйте его сейчас — он больше не будет показан:
              </p>
              <code style={{ 
                display: "block", 
                background: "#0d1f0d", 
                padding: 12, 
                borderRadius: 4,
                fontSize: 13,
                wordBreak: "break-all",
                color: "#2ecc71",
                fontFamily: "ui-monospace, monospace"
              }}>
                {generatedToken}
              </code>
              <button 
                onClick={() => navigator.clipboard.writeText(generatedToken)} 
                className="btn btn-cyan" 
                style={{ marginTop: 8, fontSize: 11 }}
              >
                Копировать в буфер
              </button>
            </div>
          )}

          {tokenMsg && <p style={{ color: "#e67e22", fontSize: 14 }}>{tokenMsg}</p>}

          <h3 style={{ marginTop: 24, fontSize: 14 }}>Активные токены</h3>
          {tokens.length === 0 ? (
            <p style={{ color: "#9ca3af", fontSize: 13 }}>Нет созданных токенов</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tokens.map((t) => (
                <div key={t.id} style={{ 
                  display: "flex", 
                  justifyContent: "space-between", 
                  alignItems: "center",
                  padding: 12,
                  background: "#25282b",
                  border: "1px solid #323538",
                  borderRadius: 4
                }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#eeeeee" }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                      Создан: {new Date(t.created_at).toLocaleDateString('ru')}
                      {t.last_used_at && ` • Использован: ${new Date(t.last_used_at).toLocaleDateString('ru')}`}
                      {t.is_revoked && <span style={{ color: "#e74c3c" }}> • ОТОЗВАН</span>}
                    </div>
                  </div>
                  {!t.is_revoked && (
                    <button onClick={() => revokeToken(t.id)} className="btn danger-btn" style={{ fontSize: 11, padding: "6px 12px" }}>
                      Отозвать
                    </button>
                  )}
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
