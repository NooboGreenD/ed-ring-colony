"use client";

import { useEffect, useState } from "react";
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
} from "@/components/Icons";
import SquadronChat from "@/components/SquadronChat";

type Tab = "overview" | "pilots" | "ranks" | "projects" | "settings" | "chat";

export default function SquadronPage() {
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
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMsg(json.error || "Ошибка сохранения");
    } else {
      setMsg("Сохранено");
      setSquadron(json.squadron);
      setForm(json.squadron);
    }
    setSaving(false);
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

  if (loading) return <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontFamily: "ui-monospace, monospace", letterSpacing: 2, textTransform: "uppercase" }}>Загрузка...</div>;
  if (!squadron) return <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Эскадрилья не найдена</div>;

  const statusText = squadron.status === "active" ? "Активна" : squadron.status === "recruiting" ? "Набор" : squadron.status === "closed" ? "Закрыта" : "Расформирована";
  const statusColor = squadron.status === "active" ? "#22c55e" : squadron.status === "recruiting" ? "#e67e22" : "#9ca3af";

  return (
    <div className="card" style={{ width: "100%" }}>
      {/* Шапка */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 12, height: 48, borderRadius: 2, background: squadron.color, flexShrink: 0 }} />
          <div>
            <div className="kicker">{squadron.tag ? `[${squadron.tag}]` : "Эскадрилья"}</div>
            <h1 style={{ margin: "4px 0 0", color: squadron.color }}>{squadron.name}</h1>
            {squadron.description && <p style={{ color: "var(--muted)", marginTop: 6, maxWidth: 600, fontSize: 14, lineHeight: 1.6 }}>{squadron.description}</p>}
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
              if (!confirm("Удалить эскадрилью? Это необратимо.")) return;
              await authFetch(`/api/squadrons/${id}`, { method: "DELETE" });
              window.location.href = "/squadrons";
            }} className="btn" style={{ fontSize: 11, padding: "6px 12px", borderColor: "#e74c3c", color: "#e74c3c" }}>
              Удалить
            </button>
          )}
        </div>
      </div>

      {/* Статистика */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{members.length}</div>
          <div className="lbl">Пилотов</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>из {squadron.member_limit || SQUADRON_MEMBER_LIMIT}</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{projects.length}</div>
          <div className="lbl">Проектов</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: squadron.color }}>{ranks.filter(r => !r.is_default).length}</div>
          <div className="lbl">Кастомных званий</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>из 15</div>
        </div>
        {squadron.allegiance && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.allegiance}</div>
            <div className="lbl">Принадлежность</div>
          </div>
        )}
        {squadron.power && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.power}</div>
            <div className="lbl">Сила</div>
          </div>
        )}
        {squadron.language && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.language}</div>
            <div className="lbl">Язык</div>
          </div>
        )}
        {squadron.home_system && (
          <div className="stat-box">
            <div className="num" style={{ color: squadron.color, fontSize: 18 }}>{squadron.home_system}</div>
            <div className="lbl">Домашняя система</div>
          </div>
        )}
      </div>

      {msg && (
        <p style={{
          color: msg === "Сохранено" ? "#22c55e" : "#e67e22",
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
        <button className={tab === "overview" ? "tab tab-active" : "tab"} onClick={() => setTab("overview")}>Обзор</button>
        <button className={tab === "pilots" ? "tab tab-active" : "tab"} onClick={() => setTab("pilots")}>Пилоты ({members.length})</button>
        <button className={tab === "ranks" ? "tab tab-active" : "tab"} onClick={() => setTab("ranks")}>Звания</button>
        <button className={tab === "projects" ? "tab tab-active" : "tab"} onClick={() => setTab("projects")}>Проекты ({projects.length})</button>
        {(canEditSquadron || isCreator) && (
          <button className={tab === "settings" ? "tab tab-active" : "tab"} onClick={() => setTab("settings")}>Настройки</button>
        )}
        {myMembership && (
          <>
            <button className={tab === "chat" ? "tab tab-active" : "tab"} onClick={() => setTab("chat")}>Чат</button>
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
                    <IconWebsite size={12} color="#22c55e" /> Веб-сайт
                  </a>
                )}
              </div>
            )}

            {/* Приветственное сообщение */}
            {squadron.recruitment_message && (
              <div className="card" style={{ background: "#25282b" }}>
                <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "ui-monospace, monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Сообщение эскадрильи</div>
                <p style={{ margin: 0, color: "var(--text)", lineHeight: 1.6 }}>{squadron.recruitment_message}</p>
              </div>
            )}
          </div>

          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Командный состав</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Пилот</th>
                  <th>Звание</th>
                  <th>Позывной</th>
                  <th>В составе с</th>
                </tr>
              </thead>
              <tbody>
                {members.filter(m => m.rank_order && m.rank_order <= 3).map(m => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {m.avatar_url ? <img src={m.avatar_url} className="avatar-sm" alt="" /> : <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#323538", flexShrink: 0 }} />}
                        <Link href={`/cmdr/${encodeURIComponent(m.cmdr_name || "")}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}>
                          {m.cmdr_name || "Неизвестный"}
                        </Link>
                      </div>
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.rank_name}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.callsign || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>{new Date(m.joined_at).toLocaleDateString("ru-RU")}</td>
                  </tr>
                ))}
                {members.filter(m => m.rank_order && m.rank_order <= 3).length === 0 && (
                  <tr><td colSpan={4} style={{ color: "var(--muted)", textAlign: "center" }}>Нет данных о командном составе</td></tr>
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

      {/* Настройки — отдельная вкладка */}
      {tab === "settings" && (canEditSquadron || isCreator) && (
        <div className="card" style={{ background: "#25282b" }}>
          <h3 style={{ margin: "0 0 16px", color: "var(--text)" }}>Настройки эскадрильи</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            {/* Название */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Название эскадрильи {nameChangeBlocked && <span style={{ color: "#e74c3c", fontSize: 11 }}>(изменено {daysUntilNameChange()} дн. назад, подождите ещё {daysUntilNameChange()} дн.)</span>}</label>
              <input
                value={form.name || ""}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                disabled={nameChangeBlocked}
                title={nameChangeBlocked ? `Название можно менять раз в ${NAME_CHANGE_COOLDOWN_DAYS} дней` : ""}
              />
            </div>

            {/* Тег */}
            <div>
              <label style={labelStyle}>Тег [TAG]</label>
              <input
                value={form.tag || ""}
                onChange={e => setForm(p => ({ ...p, tag: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder="2-10 символов"
              />
            </div>

            {/* Описание */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Описание</label>
              <textarea
                value={form.description || ""}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                style={{ width: "100%", minHeight: 80, fontSize: 13 }}
                placeholder="Описание эскадрильи..."
                maxLength={1000}
              />
            </div>

            {/* Принадлежность */}
            <div>
              <label style={labelStyle}>Принадлежность</label>
              <select
                value={form.allegiance || "Independent"}
                onChange={e => setForm(p => ({ ...p, allegiance: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ED_ALLEGIANCES.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Сила (держава) */}
            <div>
              <label style={labelStyle}>Сила (Power)</label>
              <select
                value={form.power || ""}
                onChange={e => setForm(p => ({ ...p, power: e.target.value || null }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ED_POWERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Язык */}
            <div>
              <label style={labelStyle}>Язык</label>
              <select
                value={form.language || "Russian"}
                onChange={e => setForm(p => ({ ...p, language: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>

            {/* Часовой пояс */}
            <div>
              <label style={labelStyle}>Часовой пояс</label>
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
              <label style={labelStyle}>Лимит участников</label>
              <input
                type="number"
                value={SQUADRON_MEMBER_LIMIT}
                disabled
                style={{ width: "100%", fontSize: 13, opacity: 0.6 }}
                title="Фиксированный лимит Elite Dangerous"
              />
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Фиксировано: {SQUADRON_MEMBER_LIMIT}</div>
            </div>

            {/* Тип активности */}
            <div>
              <label style={labelStyle}>Тип активности</label>
              <select
                value={form.activity_type || "Mixed"}
                onChange={e => setForm(p => ({ ...p, activity_type: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                {ACTIVITY_TYPES.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Домашняя система */}
            <div>
              <label style={labelStyle}>Домашняя система</label>
              <input
                value={form.home_system || ""}
                onChange={e => setForm(p => ({ ...p, home_system: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder="Напр. Shinrarta Dezhra"
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
              <label style={labelStyle}>Веб-сайт</label>
              <input
                value={form.website_url || ""}
                onChange={e => setForm(p => ({ ...p, website_url: e.target.value }))}
                style={{ width: "100%", fontSize: 13 }}
                placeholder="https://..."
              />
            </div>

            {/* Статус */}
            <div>
              <label style={labelStyle}>Статус набора</label>
              <select
                value={form.status || "active"}
                onChange={e => setForm(p => ({ ...p, status: e.target.value as any }))}
                style={{ width: "100%", fontSize: 13 }}
              >
                <option value="active">Активна</option>
                <option value="recruiting">Набор открыт</option>
                <option value="closed">Закрыта</option>
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
              <label htmlFor="openRecruit" style={{ ...labelStyle, margin: 0, cursor: "pointer" }}>Свободное вступление без заявки</label>
            </div>

            {/* Цвет */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={labelStyle}>Цвет:</label>
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
              <label style={labelStyle}>Приветственное сообщение для новичков</label>
              <textarea
                value={form.recruitment_message || ""}
                onChange={e => setForm(p => ({ ...p, recruitment_message: e.target.value }))}
                style={{ width: "100%", minHeight: 60, fontSize: 13 }}
                placeholder="Сообщение, которое увидят новые пилоты при вступлении..."
                maxLength={1000}
              />
            </div>
          </div>

          <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={saveSettings} className="btn btn-cyan" disabled={saving}>
              {saving ? "Сохранение..." : "Сохранить настройки"}
            </button>
            <button onClick={() => { setForm(squadron); setMsg(""); }} className="btn" disabled={saving}>
              Сбросить
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
  const [inviteName, setInviteName] = useState("");
  const [inviteRank, setInviteRank] = useState("");

  const invite = async () => {
    if (!inviteName.trim()) return;
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("cmdr_name", inviteName.trim())
      .maybeSingle();
    if (!profile) { setMsg("Пилот не найден"); return; }

    const res = await authFetch(`/api/squadrons/${squadronId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: profile.id, rank_id: inviteRank ? parseInt(inviteRank) : null }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error); return; }
    setMsg("Пилот приглашён!");
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
    if (!res.ok) { setMsg("Ошибка обновления звания"); return; }
    onUpdate();
  };

  const kick = async (user_id: string) => {
    if (!confirm("Исключить пилота?")) return;
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
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Пригласить пилота</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="CMDR имя" value={inviteName} onChange={e => setInviteName(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <select value={inviteRank} onChange={e => setInviteRank(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">Без звания</option>
              {ranks.map((r: SquadronRank) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <button onClick={invite} className="btn btn-cyan">Пригласить</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Пилот</th>
              <th>Звание</th>
              <th>Позывной</th>
              <th>В составе с</th>
              {canManage && <th>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m: SquadronMemberDetail) => (
              <tr key={m.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {m.avatar_url ? <img src={m.avatar_url} className="avatar-sm" alt="" /> : <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#323538", flexShrink: 0 }} />}
                    <Link href={`/cmdr/${encodeURIComponent(m.cmdr_name || "")}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}>
                      {m.cmdr_name || "Неизвестный"}
                    </Link>
                  </div>
                </td>
                <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.rank_name}</td>
                <td style={{ color: "var(--muted)", fontSize: 13 }}>{m.callsign || "—"}</td>
                <td style={{ color: "var(--muted)", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>{new Date(m.joined_at).toLocaleDateString("ru-RU")}</td>
                {canManage && m.user_id !== userId && (
                  <td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        value={m.rank_id || ""}
                        onChange={e => updateRank(m.user_id, e.target.value ? parseInt(e.target.value) : null)}
                        style={{ fontSize: 12, padding: "4px 8px" }}
                      >
                        <option value="">Без звания</option>
                        {ranks.map((r: SquadronRank) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      <button onClick={() => kick(m.user_id)} className="btn" style={{ fontSize: 11, padding: "4px 10px", borderColor: "#e74c3c", color: "#e74c3c" }}>Исключить</button>
                    </div>
                  </td>
                )}
                {canManage && m.user_id === userId && <td style={{ color: "var(--muted)", fontSize: 12 }}>—</td>}
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={canManage ? 5 : 4} style={{ color: "var(--muted)", textAlign: "center" }}>Нет пилотов</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== Вкладка Звания ==========
function SquadronRanksTab({ squadronId, ranks, canManage, onUpdate, setMsg }: any) {
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
    setMsg("Звание создано");
    setNewRankName("");
    onUpdate();
  };

  const remove = async (rank_id: number) => {
    if (!confirm("Удалить звание?")) return;
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
        Кастомных званий: {customCount} / 15 (всего {ranks.length} / 20)
      </div>

      {canManage && customCount < 15 && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Новое звание</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
            <input placeholder="Название звания" value={newRankName} onChange={e => setNewRankName(e.target.value)} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: "var(--muted)" }}>
              <label><input type="checkbox" checked={newPerms.can_manage_projects} onChange={e => setNewPerms(p => ({ ...p, can_manage_projects: e.target.checked }))} /> Управление проектами</label>
              <label><input type="checkbox" checked={newPerms.can_manage_members} onChange={e => setNewPerms(p => ({ ...p, can_manage_members: e.target.checked }))} /> Управление пилотами</label>
              <label><input type="checkbox" checked={newPerms.can_manage_ranks} onChange={e => setNewPerms(p => ({ ...p, can_manage_ranks: e.target.checked }))} /> Управление званиями</label>
              <label><input type="checkbox" checked={newPerms.can_edit_squadron} onChange={e => setNewPerms(p => ({ ...p, can_edit_squadron: e.target.checked }))} /> Редактирование эскадрильи</label>
            </div>
            <button onClick={create} className="btn btn-cyan">Создать звание</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Порядок</th>
              <th>Название</th>
              <th>Проекты</th>
              <th>Пилоты</th>
              <th>Звания</th>
              <th>Эскадрилья</th>
              <th>Тип</th>
              {canManage && <th>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {ranks.map((r: SquadronRank) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)" }}>{r.sort_order}</td>
                <td style={{ fontWeight: 600, color: "var(--text)" }}>{r.name}</td>
                <td style={{ color: r.can_manage_projects ? "#22c55e" : "var(--muted)" }}>{r.can_manage_projects ? "✓" : "—"}</td>
                <td style={{ color: r.can_manage_members ? "#22c55e" : "var(--muted)" }}>{r.can_manage_members ? "✓" : "—"}</td>
                <td style={{ color: r.can_manage_ranks ? "#22c55e" : "var(--muted)" }}>{r.can_manage_ranks ? "✓" : "—"}</td>
                <td style={{ color: r.can_edit_squadron ? "#22c55e" : "var(--muted)" }}>{r.can_edit_squadron ? "✓" : "—"}</td>
                <td>{r.is_default ? <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>Стандартное</span> : <span style={{ color: "#22c55e", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>Кастомное</span>}</td>
                {canManage && (
                  <td>
                    {!r.is_default && (
                      <button onClick={() => remove(r.id)} className="btn" style={{ fontSize: 11, padding: "2px 8px", borderColor: "#e74c3c", color: "#e74c3c" }}>Удалить</button>
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
    setMsg("Проект создан");
    setNewProjectName("");
    setNewProjectDesc("");
    onUpdate();
  };

  return (
    <div>
      {canManage && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Новый проект</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
            <input placeholder="Название проекта" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} />
            <textarea placeholder="Описание..." value={newProjectDesc} onChange={e => setNewProjectDesc(e.target.value)} style={{ minHeight: 60 }} />
            <button onClick={create} className="btn btn-cyan">Создать проект</button>
          </div>
        </div>
      )}

      {projects.length === 0 && <p style={{ color: "var(--muted)", fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>Проектов пока нет.</p>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
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
                <span><IconHomeSystem size={12} color="var(--muted)" /> {p.system_count || 0} систем</span>
                <span><IconDone size={12} color="var(--muted)" /> {p.systems_done || 0} готово</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
