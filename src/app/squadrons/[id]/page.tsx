"use client";

import { SQUADRON_IMAGE_LIMITS } from '@/lib/imageLimits';
import { use, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase, authFetch } from "@/lib/supabaseClient";
import type { Squadron, SquadronRank, SquadronMemberDetail } from "@/types/squadron";
import {
  ED_POWERS,
  ED_ALLEGIANCES,
  LANGUAGES,
  TIMEZONES,
  ACTIVITY_TYPES,
  SQUADRON_MEMBER_LIMIT,
  NAME_CHANGE_COOLDOWN_DAYS,
} from "@/lib/squadronConstants";
import {
  IconMembers,
  IconHomeSystem,
  IconDone,
  IconDiscord,
  IconWebsite,
  IconCheck
} from "@/components/Icons";
import SquadronChat from "@/components/SquadronChat";
import CarrierPanel from "@/components/Carriers/CarrierPanel";
import Avatar from "@/components/Avatar";
import { useI18n } from '@/lib/i18n/I18nContext';

/** Подписи типов принадлежности и активности живут в squadronConstants на
 *  русском; здесь только соответствие ключам словаря. */
const ALLEGIANCE_KEYS: Record<string, string> = {
  Independent: "sq.algIndependent",
  Alliance: "sq.algAlliance",
  Empire: "sq.algEmpire",
  Federation: "sq.algFederation",
};

const ACTIVITY_KEYS: Record<string, string> = {
  Mixed: "sq.actMixed",
  Combat: "sq.actCombat",
  Exploration: "sq.actExploration",
  Trading: "sq.actTrading",
  Mining: "sq.actMining",
  "Bounty Hunting": "sq.actBounty",
  Roleplay: "sq.actRoleplay",
  Colonia: "sq.actColonization",
};

const LANGUAGE_KEYS: Record<string, string> = { Other: "sq.langOther" };


type Tab = "overview" | "pilots" | "ranks" | "projects" | "carrier" | "settings" | "chat";

export default function SquadronPage() {
  const { t, locale } = useI18n();
  const optionLabel = (map: Record<string, string>, entry: { value: string; label: string }) => {
    const key = map[entry.value];
    if (!key) return entry.label;
    const value = t(key);
    return value === key ? entry.label : value;
  };
  const params = useParams();
  const id = parseInt(params.id as string);

  const [user, setUser] = useState<any>(null);
  const [squadron, setSquadron] = useState<Squadron | null>(null);
  const [members, setMembers] = useState<SquadronMemberDetail[]>([]);
  const [ranks, setRanks] = useState<SquadronRank[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [brandingBusy, setBrandingBusy] = useState<"logo" | "banner" | null>(null);

  const [form, setForm] = useState<Partial<Squadron>>({});

  const myMembership = members.find(m => m.user_id === user?.id);
  const canManageMembers = myMembership?.can_manage_members ?? false;
  const canManageRanks = myMembership?.can_manage_ranks ?? false;
  const canManageProjects = myMembership?.can_manage_projects ?? false;
  const canEditSquadron = myMembership?.can_edit_squadron ?? false;
  const isCreator = squadron?.created_by === user?.id;
  const isOfficer = !!myMembership && !!(
    myMembership.can_manage_members ||
    myMembership.can_manage_projects ||
    myMembership.can_manage_ranks ||
    myMembership.can_edit_squadron
  );

  const load = async () => {
    setLoading(true);
    const res = await authFetch(`/api/squadrons/${id}`);
    const json = await res.json();
    if (json.squadron) {
      setSquadron(json.squadron);
      setMembers(json.members || []);
      setRanks(json.ranks || []);
      setProjects(json.projects || []);
      setForm(json.squadron);
    }
    setLoading(false);
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    load();
  }, [id]);

  // Прямая ссылка на вкладку (карта галактики ведёт на «Авианосец»).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested === "carrier") setTab("carrier");
  }, []);

  const saveSettings = async () => {
    if (!form) return;
    setSaving(true);
    setMsg("");
    const res = await authFetch(`/api/squadrons/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        tag: form.tag,
        description: form.description,
        color: form.color,
        allegiance: form.allegiance,
        power: form.power,
        language: form.language,
        timezone: form.timezone,
        discord_url: form.discord_url,
        website_url: form.website_url,
        recruitment_message: form.recruitment_message,
        activity_type: form.activity_type,
        is_open_recruitment: form.is_open_recruitment,
        home_system: form.home_system,
        status: form.status,
        motto: form.motto,
        banner_position: form.banner_position,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMsg(json.error || t("sq.saveError"));
    } else {
      setMsg(t("sq.saved"));
      setSquadron(json.squadron);
      setForm(json.squadron);
    }
    setSaving(false);
  };

  const uploadBranding = async (kind: "logo" | "banner", file: File | null) => {
    if (!file) return;
    if (file.size > SQUADRON_IMAGE_LIMITS[kind]) {
      setMsg(t("sq.imageTooLarge", { mb: SQUADRON_IMAGE_LIMITS[kind] / 1024 / 1024 }));
      return;
    }
    setBrandingBusy(kind); setMsg("");
    const data = new FormData();
    data.set("kind", kind);
    data.set("file", file);
    try {
      const res = await authFetch(`/api/squadrons/${id}/branding`, { method: "POST", body: data });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("sq.imageUploadFailed"));
      setSquadron(json.squadron);
      setForm(json.squadron);
      setMsg(json.warning || (kind === "logo" ? t("sq.logoUpdated") : t("sq.bannerUpdated")));
    } catch (error) {
      setMsg(error instanceof Error ? error.message : t("sq.uploadError"));
    } finally { setBrandingBusy(null); }
  };

  const removeBranding = async (kind: "logo" | "banner") => {
    if (!confirm(kind === "logo" ? t("sq.deleteLogoConfirm") : t("sq.deleteBannerConfirm"))) return;
    setBrandingBusy(kind); setMsg("");
    try {
      const res = await authFetch(`/api/squadrons/${id}/branding?kind=${kind}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("sq.imageDeleteFailed"));
      setSquadron(json.squadron); setForm(json.squadron); setMsg(t("sq.brandingUpdated"));
    } catch (error) { setMsg(error instanceof Error ? error.message : t("sq.deleteError")); }
    finally { setBrandingBusy(null); }
  };

  const daysUntilNameChange = (): number | null => {
    if (!squadron?.name_changed_at) return 0;
    const last = new Date(squadron.name_changed_at);
    const now = new Date();
    const diff = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
    if (diff >= NAME_CHANGE_COOLDOWN_DAYS) return 0;
    return Math.ceil(NAME_CHANGE_COOLDOWN_DAYS - diff);
  };

  const nameChangeBlocked = daysUntilNameChange() !== null && (daysUntilNameChange() ?? 0) > 0;

  if (loading) return <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontFamily: "ui-monospace, monospace", letterSpacing: 2, textTransform: "uppercase" }}>{t("common.loading")}</div>;
  if (!squadron) return <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>{t("sq.notFound")}</div>;

  const statusText = squadron.status === "active" ? t("sq.statusActive") : squadron.status === "recruiting" ? t("sq.statusRecruiting") : squadron.status === "closed" ? t("sq.statusClosed") : t("sq.statusDisbanded");
  const statusColor = squadron.status === "active" ? "#22c55e" : squadron.status === "recruiting" ? "#e67e22" : "#9ca3af";

  return (
    <div className="card" style={{ width: "100%" }}>
      {/* Шапка */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16,
        marginBottom: 24, padding: squadron.banner_url ? "32px 22px" : 0, borderRadius: 4, position: "relative", overflow: "hidden",
        backgroundImage: squadron.banner_url ? `linear-gradient(90deg, rgba(12,14,16,.94), rgba(12,14,16,.58)), url("${squadron.banner_url}")` : undefined,
        backgroundSize: "cover", backgroundPosition: `center ${squadron.banner_position || "center"}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative", zIndex: 1 }}>
          {squadron.logo_url ? (
            <img src={squadron.logo_url} alt={t("sq.logoAlt", { name: squadron.name })} style={{ width: 88, height: 88, objectFit: "contain", borderRadius: 8, background: "rgba(0,0,0,.45)", border: `1px solid ${squadron.color}`, padding: 4 }} />
          ) : <div style={{ width: 12, height: 48, borderRadius: 2, background: squadron.color, flexShrink: 0 }} />}
          <div>
            <div className="kicker">{squadron.tag ? `[${squadron.tag}]` : t("sq.squadron")}</div>
            <h1 style={{ margin: "4px 0 0", color: squadron.color }}>{squadron.name}</h1>
            {squadron.motto && <div style={{ color: "#f3f4f6", fontSize: 13, fontStyle: "italic", marginTop: 4 }}>«{squadron.motto}»</div>}
            {squadron.description && <p style={{ color: squadron.banner_url ? "#d1d5db" : "var(--muted)", marginTop: 6, maxWidth: 600, fontSize: 14, lineHeight: 1.6 }}>{squadron.description}</p>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            padding: "4px 12px",
            borderRadius: 2,
            fontSize: 11,
            background: `${statusColor}15`,
            color: statusColor,
            fontWeight: 600,
            fontFamily: "ui-monospace, monospace",
            letterSpacing: 1,
            textTransform: "uppercase",
          }}>
            {statusText}
          </span>
          {isCreator && (
            <button onClick={async () => {
              if (!confirm(t("sq.deleteConfirm"))) return;
              await authFetch(`/api/squadrons/${id}`, { method: "DELETE" });
              window.location.href = "/squadrons";
            }} className="btn" style={{ fontSize: 11, padding: "6px 12px", borderColor: "#e74c3c", color: "#e74c3c" }}>
              {t("sq.delete")}
            </button>
          )}
        </div>
      </div>

      {/* Статистика */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{members.length}</div>
          <div className="lbl">{t("sq.pilots")}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>{t("sq.outOf", { max: squadron.member_limit || SQUADRON_MEMBER_LIMIT })}</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{projects.length}</div>
          <div className="lbl">{t("sq.projects")}</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{ranks.filter(r => !r.is_default).length}</div>
          <div className="lbl">{t("sq.customRanks")}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>{t("sq.outOf", { max: 15 })}</div>
        </div>
        {squadron.allegiance && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.allegiance}</div>
            <div className="lbl">{t("sq.allegiance")}</div>
          </div>
        )}
        {squadron.power && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.power}</div>
            <div className="lbl">{t("sq.power")}</div>
          </div>
        )}
        {squadron.language && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.language}</div>
            <div className="lbl">{t("sq.language")}</div>
          </div>
        )}
        {squadron.home_system && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.home_system}</div>
            <div className="lbl">{t("sq.homeSystem")}</div>
          </div>
        )}
      </div>

      {msg && (
        <p style={{
          color: msg === t("sq.saved") ? "#22c55e" : "#e67e22",
          marginBottom: 16,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          letterSpacing: 1
        }}>
          {msg}
        </p>
      )}

      {/* Вкладки */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={tab === "overview" ? "tab tab-active" : "tab"} onClick={() => setTab("overview")}>{t("sq.tabOverview")}</button>
        <button className={tab === "pilots" ? "tab tab-active" : "tab"} onClick={() => setTab("pilots")}>{t("sq.tabPilots", { count: members.length })}</button>
        <button className={tab === "ranks" ? "tab tab-active" : "tab"} onClick={() => setTab("ranks")}>{t("sq.tabRanks")}</button>
        <button className={tab === "projects" ? "tab tab-active" : "tab"} onClick={() => setTab("projects")}>{t("sq.tabProjects", { count: projects.length })}</button>
        <button className={tab === "carrier" ? "tab tab-active" : "tab"} onClick={() => setTab("carrier")}>{t("sq.tabCarrier")}</button>
        {(canEditSquadron || isCreator) && (
          <button className={tab === "settings" ? "tab tab-active" : "tab"} onClick={() => setTab("settings")}>{t("sq.tabSettings")}</button>
        )}
        {myMembership && (
          <>
            <button className={tab === "chat" ? "tab tab-active" : "tab"} onClick={() => setTab("chat")}>{t("sq.tabChat")}</button>
          </>
        )}
      </div>

      {/* Обзор */}
      {tab === "overview" && (
        <div>
          {/* Публичная информация */}
          <div style={{ marginBottom: 24 }}>
            {/* Кнопки Discord / Сайт */}
            {(squadron.discord_url || squadron.website_url) && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                {squadron.discord_url && (
                  <a
                    href={squadron.discord_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn"
                    style={{
                      background: "rgba(88,101,242,0.12)",
                      borderColor: "#5865F255",
                      color: "#5865F2",
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: "ui-monospace, monospace",
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <IconDiscord size={12} color="#5865F2" /> Discord
                  </a>
                )}
                {squadron.website_url && (
                  <a
                    href={squadron.website_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn"
                    style={{
                      background: "rgba(34,197,94,0.12)",
                      borderColor: "#22c55e55",
                      color: "#22c55e",
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: "ui-monospace, monospace",
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <IconWebsite size={12} color="#22c55e" /> {t("sq.website")}
                  </a>
                )}
              </div>
            )}

            {/* Приветственное сообщение */}
            {squadron.recruitment_message && (
              <div className="card" style={{ background: "#25282b" }}>
                <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "ui-monospace, monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{t("sq.squadronMessage")}</div>
                <p style={{ margin: 0, color: "var(--text)", lineHeight: 1.6 }}>{squadron.recruitment_message}</p>
              </div>
            )}
          </div>

          <h3 style={{ marginTop: 0, marginBottom: 12 }}>{t("sq.staff")}</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("sq.thPilot")}</th>
                  <th>{t("sq.thRank")}</th>
                  <th>{t("sq.thCallsign")}</th>
                  <th>{t("sq.thSince")}</th>
                </tr>
              </thead>
              <tbody>
                {members.filter(m => m.rank_order && m.rank_order <= 3).map(m => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar url={m.avatar_url} name={m.cmdr_name} size={34} className="avatar-sm" />
                        <Link href={`/cmdr/${encodeURIComponent(m.cmdr_name || "")}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}>
                          {m.cmdr_name || t("sq.unknownPilot")}
                        </Link>
                      </div>
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.rank_name}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.callsign || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>{new Date(m.joined_at).toLocaleDateString(locale)}</td>
                  </tr>
                ))}
                {members.filter(m => m.rank_order && m.rank_order <= 3).length === 0 && (
                  <tr><td colSpan={4} style={{ color: "var(--muted)", textAlign: "center" }}>{t("sq.noStaff")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Пилоты */}
      {tab === "pilots" && (
        <SquadronPilotsTab
          squadronId={id}
          members={members}
          ranks={ranks}
          canManage={canManageMembers}
          userId={user?.id}
          onUpdate={load}
          setMsg={setMsg}
        />
      )}

      {/* Звания */}
      {tab === "ranks" && (
        <SquadronRanksTab
          squadronId={id}
          ranks={ranks}
          canManage={canManageRanks}
          onUpdate={load}
          setMsg={setMsg}
        />
      )}

      {/* Проекты */}
      {tab === "projects" && (
        <SquadronProjectsTab
          squadronId={id}
          projects={projects}
          canManage={canManageProjects}
          onUpdate={load}
          setMsg={setMsg}
        />
      )}

      {/* Эскадренный авианосец: статус, система, службы, трюм, рынок */}
      {tab === "carrier" && Number.isSafeInteger(Number(id)) && (
        <CarrierPanel mode="squadron" squadronId={Number(id)} />
      )}

      {/* Настройки — отдельная вкладка */}
      {tab === "settings" && (canEditSquadron || isCreator) && (
        <div className="card" style={{ background: "#25282b" }}>
          <h3 style={{ margin: "0 0 16px", color: "var(--text)" }}>{t("sq.settingsTitle")}</h3>

          <div style={{ border: "1px solid var(--line)", background: "var(--bg)", padding: 14, marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 10px", color: "var(--text)" }}>{t("sq.brandingTitle")}</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 14 }}>
              <div>
                <label style={labelStyle}>{t("sq.logoLabel", { mb: SQUADRON_IMAGE_LIMITS.logo / 1024 / 1024 })}</label>
                {form.logo_url && <img src={form.logo_url} alt={t("sq.logoAlt", { name: form.name || t("sq.squadron") })} style={{ width: 92, height: 92, objectFit: "contain", display: "block", marginBottom: 8, background: "#111", border: "1px solid var(--line)" }} />}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={brandingBusy !== null} onChange={e => { void uploadBranding("logo", e.target.files?.[0] ?? null); e.target.value = ""; }} />
                {form.logo_url && <button type="button" className="btn" disabled={brandingBusy !== null} onClick={() => void removeBranding("logo")} style={{ fontSize: 11, marginTop: 6 }}>{t("sq.removeLogo")}</button>}
              </div>
              <div>
                <label style={labelStyle}>{t("sq.bannerLabel", { mb: SQUADRON_IMAGE_LIMITS.banner / 1024 / 1024 })}</label>
                {form.banner_url && <div style={{ height: 92, marginBottom: 8, backgroundImage: `url("${form.banner_url}")`, backgroundSize: "cover", backgroundPosition: `center ${form.banner_position || "center"}`, border: "1px solid var(--line)" }} />}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={brandingBusy !== null} onChange={e => { void uploadBranding("banner", e.target.files?.[0] ?? null); e.target.value = ""; }} />
                {form.banner_url && <button type="button" className="btn" disabled={brandingBusy !== null} onClick={() => void removeBranding("banner")} style={{ fontSize: 11, marginTop: 6 }}>{t("sq.removeBanner")}</button>}
              </div>
              <div>
                <label style={labelStyle}>{t("sq.bannerPosition")}</label>
                <select value={form.banner_position || "center"} onChange={e => setForm(p => ({ ...p, banner_position: e.target.value as Squadron["banner_position"] }))} style={{ width: "100%" }}>
                  <option value="top">{t("sq.posTop")}</option><option value="center">{t("sq.posCenter")}</option><option value="bottom">{t("sq.posBottom")}</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t("sq.motto")}</label>
                <input value={form.motto || ""} maxLength={160} onChange={e => setForm(p => ({ ...p, motto: e.target.value }))} placeholder={t("sq.mottoPlaceholder")} style={{ width: "100%" }} />
              </div>
            </div>
            {brandingBusy && <div style={{ color: "var(--cyan)", fontSize: 12, marginTop: 8 }}>{t("sq.imageUploading")}</div>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 12 }}>
            {/* Название */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>{t("sq.nameLabel")} {nameChangeBlocked && <span style={{ color: "#e74c3c", fontSize: 11 }}>{t("sq.nameCooldownDays", { days: daysUntilNameChange() ?? 0 })}</span>}</label>
              <input
                value={form.name || ""}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                disabled={nameChangeBlocked}
                title={nameChangeBlocked ? t("sq.nameCooldownTitle", { days: NAME_CHANGE_COOLDOWN_DAYS }) : ""}
              />
            </div>

            {/* Тег */}
            <div>
              <label style={labelStyle}>{t("sq.tagLabel")}</label>
              <input
                value={form.tag || ""}
                onChange={e => setForm(p => ({ ...p, tag: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder={t("sq.tagPlaceholder")}
              />
            </div>

            {/* Описание */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>{t("sq.description")}</label>
              <textarea
                value={form.description || ""}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                style={{ width: "100%", minHeight: 80, fontSize: 13 }}
                placeholder={t("sq.descriptionPlaceholder")}
                maxLength={1000}
              />
            </div>

            {/* Принадлежность */}
            <div>
              <label style={labelStyle}>{t("sq.allegiance")}</label>
              <select
                value={form.allegiance || "Independent"}
                onChange={e => setForm(p => ({ ...p, allegiance: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ED_ALLEGIANCES.map(a => (
                  <option key={a.value} value={a.value}>{optionLabel(ALLEGIANCE_KEYS, a)}</option>
                ))}
              </select>
            </div>

            {/* Сила (держава) */}
            <div>
              <label style={labelStyle}>{t("sq.powerLabel")}</label>
              <select
                value={form.power || ""}
                onChange={e => setForm(p => ({ ...p, power: e.target.value || null }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ED_POWERS.map(p => (
                  <option key={p.value} value={p.value}>{p.value ? p.label : t("sq.noneSelected")}</option>
                ))}
              </select>
            </div>

            {/* Язык */}
            <div>
              <label style={labelStyle}>{t("sq.language")}</label>
              <select
                value={form.language || "Russian"}
                onChange={e => setForm(p => ({ ...p, language: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{optionLabel(LANGUAGE_KEYS, l)}</option>
                ))}
              </select>
            </div>

            {/* Часовой пояс */}
            <div>
              <label style={labelStyle}>{t("sq.timezone")}</label>
              <select
                value={form.timezone || "UTC+03:00"}
                onChange={e => setForm(p => ({ ...p, timezone: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {TIMEZONES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Лимит участников */}
            <div>
              <label style={labelStyle}>{t("sq.memberLimit")}</label>
              <input
                type="number"
                value={SQUADRON_MEMBER_LIMIT}
                disabled
                style={{ width: "100%", fontSize: 13, opacity: 0.6 }}
                title={t("sq.memberLimitTitle")}
              />
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{t("sq.fixedValue", { value: SQUADRON_MEMBER_LIMIT })}</div>
            </div>

            {/* Тип активности */}
            <div>
              <label style={labelStyle}>{t("sq.activityType")}</label>
              <select
                value={form.activity_type || "Mixed"}
                onChange={e => setForm(p => ({ ...p, activity_type: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ACTIVITY_TYPES.map(a => (
                  <option key={a.value} value={a.value}>{optionLabel(ALLEGIANCE_KEYS, a)}</option>
                ))}
              </select>
            </div>

            {/* Домашняя система */}
            <div>
              <label style={labelStyle}>{t("sq.homeSystem")}</label>
              <input
                value={form.home_system || ""}
                onChange={e => setForm(p => ({ ...p, home_system: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder={t("sq.homeSystemPlaceholder")}
              />
            </div>

            {/* Discord */}
            <div>
              <label style={labelStyle}>Discord</label>
              <input
                value={form.discord_url || ""}
                onChange={e => setForm(p => ({ ...p, discord_url: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder="https://discord.gg/..."
              />
            </div>

            {/* Сайт */}
            <div>
              <label style={labelStyle}>{t("sq.website")}</label>
              <input
                value={form.website_url || ""}
                onChange={e => setForm(p => ({ ...p, website_url: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder="https://..."
              />
            </div>

            {/* Статус */}
            <div>
              <label style={labelStyle}>{t("sq.recruitStatus")}</label>
              <select
                value={form.status || "active"}
                onChange={e => setForm(p => ({ ...p, status: e.target.value as any }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                <option value="active">{t("sq.statusActive")}</option>
                <option value="recruiting">{t("sq.statusRecruitingOpen")}</option>
                <option value="closed">{t("sq.statusClosed")}</option>
              </select>
            </div>

            {/* Открытый набор */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 40 }}>
              <input
                id="openRecruit"
                type="checkbox"
                checked={form.is_open_recruitment ?? true}
                onChange={e => setForm(p => ({ ...p, is_open_recruitment: e.target.checked }))}
              />
              <label htmlFor="openRecruit" style={{ ...labelStyle, margin: 0, cursor: "pointer" }}>{t("sq.openRecruit")}</label>
            </div>

            {/* Цвет */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={labelStyle}>{t("sq.color")}</label>
              <input
                type="color"
                value={form.color || "#3b82f6"}
                onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                style={{ width: 60, height: 36, border: "none", borderRadius: 2, cursor: "pointer" }}
              />
              <span style={{ color: form.color, fontSize: 13, fontWeight: 600, fontFamily: "ui-monospace, monospace" }}>{form.color}</span>
            </div>

            {/* Приветственное сообщение */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>{t("sq.welcomeLabel")}</label>
              <textarea
                value={form.recruitment_message || ""}
                onChange={e => setForm(p => ({ ...p, recruitment_message: e.target.value }))}
                style={{ width: "100%", minHeight: 60, fontSize: 13 }}
                placeholder={t("sq.welcomePlaceholder")}
                maxLength={1000}
              />
            </div>
          </div>

          <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={saveSettings} className="btn btn-cyan" disabled={saving}>
              {saving ? t("sq.saving") : t("sq.saveSettings")}
            </button>
            <button onClick={() => { setForm(squadron); setMsg(""); }} className="btn" disabled={saving}>
              {t("sq.reset")}
            </button>
          </div>
        </div>
      )}

      {/* Чат */}
      {tab === "chat" && myMembership && (
        <SquadronChat
          squadronId={id}
          userId={user.id}
          isOfficer={isOfficer}
          members={members.map(m => ({
            user_id: m.user_id,
            cmdr_name: m.cmdr_name,
            avatar_url: m.avatar_url,
          }))}
        />
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  display: "block",
  marginBottom: 4,
  fontFamily: "ui-monospace, monospace",
  letterSpacing: 1,
  textTransform: "uppercase",
};

// ========== Вкладка Пилоты ==========
function SquadronPilotsTab({ squadronId, members, ranks, canManage, userId, onUpdate, setMsg }: any) {
  const { t, locale } = useI18n();
  const [inviteName, setInviteName] = useState("");
  const [inviteRank, setInviteRank] = useState("");

  const invite = async () => {
    if (!inviteName.trim()) return;
    const { data: profile } = await supabase
      .from("public_profiles")
      .select("id")
      .eq("cmdr_name", inviteName.trim())
      .maybeSingle();
    if (!profile) { setMsg(t("sq.pilotNotFound")); return; }

    const res = await authFetch(`/api/squadrons/${squadronId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: profile.id, rank_id: inviteRank ? parseInt(inviteRank) : null }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error); return; }
    setMsg(t("sq.pilotInvited"));
    setInviteName("");
    setInviteRank("");
    onUpdate();
  };

  const updateRank = async (user_id: string, rank_id: number | null) => {
    const res = await authFetch(`/api/squadrons/${squadronId}/members`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, rank_id }),
    });
    if (!res.ok) { setMsg(t("sq.rankUpdateError")); return; }
    onUpdate();
  };

  const kick = async (user_id: string) => {
    if (!confirm(t("sq.kickConfirm"))) return;
    await authFetch(`/api/squadrons/${squadronId}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });
    onUpdate();
  };

  return (
    <div>
      {canManage && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>{t("sq.inviteTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder={t("sq.cmdrNamePlaceholder")} value={inviteName} onChange={e => setInviteName(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <select value={inviteRank} onChange={e => setInviteRank(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">{t("sq.noRank")}</option>
              {ranks.map((r: SquadronRank) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <button onClick={invite} className="btn btn-cyan">{t("sq.invite")}</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("sq.thPilot")}</th>
              <th>{t("sq.thRank")}</th>
              <th>{t("sq.thCallsign")}</th>
              <th>{t("sq.thSince")}</th>
              {canManage && <th>{t("sq.thActions")}</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m: SquadronMemberDetail) => (
              <tr key={m.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar url={m.avatar_url} name={m.cmdr_name} size={34} className="avatar-sm" />
                    <Link href={`/cmdr/${encodeURIComponent(m.cmdr_name || "")}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}>
                      {m.cmdr_name || t("sq.unknownPilot")}
                    </Link>
                  </div>
                </td>
                <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.rank_name}</td>
                <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.callsign || "—"}</td>
                <td style={{ color: "var(--muted)", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>{new Date(m.joined_at).toLocaleDateString(locale)}</td>
                {canManage && m.user_id !== userId && (
                  <td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        value={m.rank_id || ""}
                        onChange={e => updateRank(m.user_id, e.target.value ? parseInt(e.target.value) : null)}
                        style={{ fontSize: 12, padding: "4px 8px" }}
                      >
                        <option value="">{t("sq.noRank")}</option>
                        {ranks.map((r: SquadronRank) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      <button onClick={() => kick(m.user_id)} className="btn" style={{ fontSize: 11, padding: "4px 10px", borderColor: "#e74c3c", color: "#e74c3c" }}>{t("sq.kick")}</button>
                    </div>
                  </td>
                )}
                {canManage && m.user_id === userId && <td style={{ color: "var(--muted)", fontSize: 12 }}>—</td>}
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={canManage ? 5 : 4} style={{ color: "var(--muted)", textAlign: "center" }}>{t("sq.noPilots")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== Вкладка Звания ==========
function SquadronRanksTab({ squadronId, ranks, canManage, onUpdate, setMsg }: any) {
  const { t } = useI18n();
  const [newRankName, setNewRankName] = useState("");
  const [newRankOrder, setNewRankOrder] = useState(99);
  const [newPerms, setNewPerms] = useState({
    can_manage_projects: false,
    can_manage_members: false,
    can_manage_ranks: false,
    can_edit_squadron: false,
  });

  const create = async () => {
    if (!newRankName.trim()) return;
    const res = await authFetch(`/api/squadrons/${squadronId}/ranks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newRankName, sort_order: newRankOrder, ...newPerms }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error); return; }
    setMsg(t("sq.rankCreated"));
    setNewRankName("");
    onUpdate();
  };

  const editName = async (rank: SquadronRank) => {
    if (rank.is_default) return;
    const name = window.prompt(t("sq.rankNamePrompt"), rank.name)?.trim();
    if (!name || name === rank.name) return;
    const res = await authFetch(`/api/squadrons/${squadronId}/ranks`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rank_id: rank.id, name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg(json.error || t("sq.rankRenameError")); return; }
    setMsg(t("sq.rankRenamed"));
    onUpdate();
  };

  const remove = async (rank_id: number) => {
    if (!confirm(t("sq.rankDeleteConfirm"))) return;
    const res = await authFetch(`/api/squadrons/${squadronId}/ranks`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rank_id }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error); return; }
    onUpdate();
  };

  const customCount = ranks.filter((r: SquadronRank) => !r.is_default).length;

  return (
    <div>
      <div style={{ marginBottom: 16, color: "var(--muted)", fontSize: 14, fontFamily: "ui-monospace, monospace" }}>
        {t("sq.ranksSummary", { custom: customCount, total: ranks.length })}
      </div>

      {canManage && customCount < 15 && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>{t("sq.newRank")}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
            <input placeholder={t("sq.rankNamePlaceholder")} value={newRankName} onChange={e => setNewRankName(e.target.value)} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: "var(--muted)" }}>
              <label><input type="checkbox" checked={newPerms.can_manage_projects} onChange={e => setNewPerms(p => ({ ...p, can_manage_projects: e.target.checked }))} /> {t("sq.permProjects")}</label>
              <label><input type="checkbox" checked={newPerms.can_manage_members} onChange={e => setNewPerms(p => ({ ...p, can_manage_members: e.target.checked }))} /> {t("sq.permMembers")}</label>
              <label><input type="checkbox" checked={newPerms.can_manage_ranks} onChange={e => setNewPerms(p => ({ ...p, can_manage_ranks: e.target.checked }))} /> {t("sq.permRanks")}</label>
              <label><input type="checkbox" checked={newPerms.can_edit_squadron} onChange={e => setNewPerms(p => ({ ...p, can_edit_squadron: e.target.checked }))} /> {t("sq.permEdit")}</label>
            </div>
            <button onClick={create} className="btn btn-cyan">{t("sq.createRank")}</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("sq.thOrder")}</th>
              <th>{t("sq.thName")}</th>
              <th>{t("sq.thProjects")}</th>
              <th>{t("sq.thPilots")}</th>
              <th>{t("sq.thRanks")}</th>
              <th>{t("sq.thSquadron")}</th>
              <th>{t("sq.thType")}</th>
              {canManage && <th>{t("sq.thActions")}</th>}
            </tr>
          </thead>
          <tbody>
            {ranks.map((r: SquadronRank) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)" }}>{r.sort_order}</td>
                <td style={{ fontWeight: 600, color: "var(--text)" }}>
                  {r.name}
                  {canManage && !r.is_default && (
                    <button onClick={() => editName(r)} className="btn" style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px" }}>{t("sq.rename")}</button>
                  )}
                </td>
                <td style={{ color: r.can_manage_projects ? "#22c55e" : "var(--muted)" }}>{r.can_manage_projects ? <IconCheck size={14} color="#22c55e" /> : "—"}</td>
                <td style={{ color: r.can_manage_members ? "#22c55e" : "var(--muted)" }}>{r.can_manage_members ? <IconCheck size={14} color="#22c55e" /> : "—"}</td>
                <td style={{ color: r.can_manage_ranks ? "#22c55e" : "var(--muted)" }}>{r.can_manage_ranks ? <IconCheck size={14} color="#22c55e" /> : "—"}</td>
                <td style={{ color: r.can_edit_squadron ? "#22c55e" : "var(--muted)" }}>{r.can_edit_squadron ? <IconCheck size={14} color="#22c55e" /> : "—"}</td>
                <td>{r.is_default ? <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{t("sq.defaultRank")}</span> : <span style={{ color: "#22c55e", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{t("sq.customRank")}</span>}</td>
                {canManage && (
                  <td>
                    {!r.is_default && (
                      <button onClick={() => remove(r.id)} className="btn" style={{ fontSize: 11, padding: "2px 8px", borderColor: "#e74c3c", color: "#e74c3c" }}>{t("sq.delete")}</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== Вкладка Проекты ==========
function SquadronProjectsTab({ squadronId, projects, canManage, onUpdate, setMsg }: any) {
  const { t } = useI18n();
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");

  const create = async () => {
    if (!newProjectName.trim()) return;
    const res = await authFetch(`/api/squadrons/${squadronId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName, description: newProjectDesc }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error); return; }
    setMsg(t("sq.projectCreated"));
    setNewProjectName("");
    setNewProjectDesc("");
    onUpdate();
  };

  return (
    <div>
      {canManage && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>{t("sq.newProject")}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
            <input placeholder={t("sq.projectNamePlaceholder")} value={newProjectName} onChange={e => setNewProjectName(e.target.value)} />
            <textarea placeholder={t("sq.projectDescPlaceholder")} value={newProjectDesc} onChange={e => setNewProjectDesc(e.target.value)} style={{ minHeight: 60 }} />
            <button onClick={create} className="btn btn-cyan">{t("sq.createProject")}</button>
          </div>
        </div>
      )}

      {projects.length === 0 && <p style={{ color: "var(--muted)", fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>{t("sq.noProjects")}</p>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
        {projects.map((p: any) => (
          <Link key={p.id} href={`/projects/${p.id}`} style={{ textDecoration: "none" }}>
            <div className="card" style={{
              borderLeft: `3px solid ${p.color || "#e67e22"}`,
              transition: "border-color 0.2s, transform 0.2s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = p.color || "#e67e22"; (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--line)"; (e.currentTarget as HTMLElement).style.transform = "translateY(0)"; }}
            >
              <h3 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>{p.name}</h3>
              {p.description && <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{p.description}</p>}
              <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 12, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
                <span><IconMembers size={12} color="var(--muted)" /> {p.member_count || 0}</span>
                <span><IconHomeSystem size={12} color="var(--muted)" /> {t("sq.systemsCount", { count: p.system_count || 0 })}</span>
                <span><IconDone size={12} color="var(--muted)" /> {t("sq.doneCount", { count: p.systems_done || 0 })}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
