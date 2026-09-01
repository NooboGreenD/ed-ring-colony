"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { Toaster, toast } from "@/components/ui/Toaster";
import { useRouter } from "next/navigation";
import {
  ED_POWERS,
  ED_ALLEGIANCES,
  LANGUAGES,
  TIMEZONES,
  ACTIVITY_TYPES,
  SQUADRON_MEMBER_LIMIT,
} from "@/lib/squadronConstants";
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

type SquadronItem = {
  id: number;
  name: string;
  tag: string | null;
  description: string | null;
  color: string;
  icon: string;
  status: string;
  allegiance: string | null;
  power: string | null;
  language: string | null;
  timezone: string | null;
  member_limit: number | null;
  member_count: number;
  project_count: number;
  activity_type: string | null;
  home_system: string | null;
  discord_url: string | null;
  website_url: string | null;
  is_open_recruitment: boolean;
  created_at: string;
};

export default function SquadronsListPage() {
  const router = useRouter();
  const [squadrons, setSquadrons] = useState<SquadronItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [mySquadronId, setMySquadronId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    tag: "",
    description: "",
    color: "#e67e22",
    allegiance: "Independent",
    power: "",
    language: "Russian",
    timezone: "UTC+03:00",
    discord_url: "",
    website_url: "",
    home_system: "",
    activity_type: "Mixed",
  });
  const [filter, setFilter] = useState<"all" | "recruiting" | "active">("all");

  useEffect(() => {
    loadSquadrons();
    loadUser();
  }, []);

  const loadUser = async () => {
    const { data } = await supabase.auth.getUser();
    setUser(data.user);
    if (data.user) {
      const { data: membership } = await supabase
        .from("squadron_members")
        .select("squadron_id")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (membership) setMySquadronId(membership.squadron_id);
    }
  };

  const loadSquadrons = async () => {
    setLoading(true);
    const res = await fetch("/api/squadrons?limit=100");
    const json = await res.json();
    setSquadrons(json.squadrons || []);
    setLoading(false);
  };

  const createSquadron = async () => {
    if (!createForm.name.trim()) {
      toast("Введите название эскадрильи", "error");
      return;
    }
    const res = await fetch("/api/squadrons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    const json = await res.json();
    if (!res.ok) {
      toast(json.error || "Ошибка создания", "error");
      return;
    }
    toast("Эскадрилья создана!", "success");
    setShowCreate(false);
    setCreateForm({
      name: "", tag: "", description: "", color: "#e67e22",
      allegiance: "Independent", power: "", language: "Russian",
      timezone: "UTC+03:00", discord_url: "", website_url: "",
      home_system: "", activity_type: "Mixed",
    });
    loadSquadrons();
    loadUser();
  };

  const applyToSquadron = async (squadronId: number) => {
    if (!user) {
      toast("Войдите в аккаунт, чтобы подать заявку", "error");
      router.push("/login");
      return;
    }
    if (mySquadronId) {
      toast("Вы уже состоите в эскадрилье. Сначала покиньте текущую.", "error");
      return;
    }
    const res = await fetch(`/api/squadrons/${squadronId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast(json.error || "Ошибка подачи заявки", "error");
      return;
    }
    toast("Заявка подана! Ожидайте подтверждения командира.", "success");
    setMySquadronId(squadronId);
  };

  const leaveSquadron = async () => {
    if (!user || !mySquadronId) return;
    if (!confirm("Покинуть эскадрилью?")) return;
    const res = await fetch(`/api/squadrons/${mySquadronId}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    if (res.ok) {
      toast("Вы покинули эскадрилью", "success");
      setMySquadronId(null);
      loadSquadrons();
    } else {
      toast("Ошибка", "error");
    }
  };

  const filtered = squadrons.filter((s) => {
    if (filter === "all") return true;
    return s.status === filter;
  });

  const statusLabel = (s: string) => {
    switch (s) {
      case "active": return "Активна";
      case "recruiting": return "Набор";
      case "closed": return "Закрыта";
      case "disbanded": return "Расформирована";
      default: return s;
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "active": return "#22c55e";
      case "recruiting": return "#e67e22";
      case "closed": return "#9ca3af";
      case "disbanded": return "#e74c3c";
      default: return "#9ca3af";
    }
  };

  const allegianceIcon = (a: string | null) => {
    switch (a) {
      case "Alliance": return <AllegianceIcon allegiance="Alliance" size={12} color="#22c55e" />;
      case "Empire": return <AllegianceIcon allegiance="Empire" size={12} color="#a855f7" />;
      case "Federation": return <AllegianceIcon allegiance="Federation" size={12} color="#3b82f6" />;
      default: return <AllegianceIcon allegiance="Independent" size={12} color="#9ca3af" />;
    }
  };

  return (
    <main className="card" style={{ width: "100%" }}>
      <Toaster />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="kicker">Реестр эскадрилий</div>
          <h1 style={{ marginTop: 8 }}>Эскадрильи колонизации</h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {mySquadronId && (
            <button onClick={leaveSquadron} className="btn" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
              Покинуть эскадрилью
            </button>
          )}
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="btn btn-orange"
            disabled={!!mySquadronId}
            title={mySquadronId ? "Сначала покиньте текущую эскадрилью" : ""}
          >
            {showCreate ? "Отмена" : "+ Создать эскадрилью"}
          </button>
        </div>
      </div>

      {/* Фильтры */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        {(["all", "active", "recruiting"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? "tab tab-active" : "tab"}
          >
            {f === "all" ? "Все" : f === "active" ? "Активные" : "Набор открыт"}
            {" "}({f === "all" ? squadrons.length : squadrons.filter((s) => s.status === f).length})
          </button>
        ))}
      </div>

      {/* Форма создания */}
      {showCreate && (
        <div className="card" style={{ marginBottom: 24, background: "#25282b" }}>
          <h3 style={{ margin: "0 0 16px", color: "var(--text)" }}>Новая эскадрилья</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 800 }}>
            <input placeholder="Название эскадрильи *" value={createForm.name} onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))} style={{ width: "100%" }} />
            <input placeholder="Тег [TAG] (2-10 символов)" value={createForm.tag} onChange={(e) => setCreateForm((p) => ({ ...p, tag: e.target.value }))} style={{ width: "100%" }} />
            <textarea placeholder="Описание эскадрильи..." value={createForm.description} onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))} style={{ minHeight: 80 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={fieldLabel}>Цвет:</label>
              <input type="color" value={createForm.color} onChange={(e) => setCreateForm((p) => ({ ...p, color: e.target.value }))} style={{ width: 60, height: 36, border: "none", borderRadius: 2, cursor: "pointer" }} />
              <span style={{ color: createForm.color, fontSize: 13, fontWeight: 600, fontFamily: "ui-monospace, monospace" }}>{createForm.color}</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <div>
                <label style={fieldLabel}>Принадлежность</label>
                <select value={createForm.allegiance} onChange={(e) => setCreateForm((p) => ({ ...p, allegiance: e.target.value }))} style={{ width: "100%" }}>
                  {ED_ALLEGIANCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Сила (Power)</label>
                <select value={createForm.power} onChange={(e) => setCreateForm((p) => ({ ...p, power: e.target.value }))} style={{ width: "100%" }}>
                  {ED_POWERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Язык</label>
                <select value={createForm.language} onChange={(e) => setCreateForm((p) => ({ ...p, language: e.target.value }))} style={{ width: "100%" }}>
                  {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Часовой пояс</label>
                <select value={createForm.timezone} onChange={(e) => setCreateForm((p) => ({ ...p, timezone: e.target.value }))} style={{ width: "100%" }}>
                  {TIMEZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Лимит участников</label>
                <input type="number" value={SQUADRON_MEMBER_LIMIT} disabled style={{ width: "100%", opacity: 0.6 }} title="Фиксированный лимит Elite Dangerous" />
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Фиксировано: {SQUADRON_MEMBER_LIMIT}</div>
              </div>
              <div>
                <label style={fieldLabel}>Тип активности</label>
                <select value={createForm.activity_type} onChange={(e) => setCreateForm((p) => ({ ...p, activity_type: e.target.value }))} style={{ width: "100%" }}>
                  {ACTIVITY_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Discord</label>
                <input placeholder="https://discord.gg/..." value={createForm.discord_url} onChange={(e) => setCreateForm((p) => ({ ...p, discord_url: e.target.value }))} style={{ width: "100%" }} />
              </div>
              <div>
                <label style={fieldLabel}>Веб-сайт</label>
                <input placeholder="https://..." value={createForm.website_url} onChange={(e) => setCreateForm((p) => ({ ...p, website_url: e.target.value }))} style={{ width: "100%" }} />
              </div>
              <div>
                <label style={fieldLabel}>Домашняя система</label>
                <input placeholder="Напр. Shinrarta Dezhra" value={createForm.home_system} onChange={(e) => setCreateForm((p) => ({ ...p, home_system: e.target.value }))} style={{ width: "100%" }} />
              </div>
            </div>

            <button onClick={createSquadron} className="btn btn-cyan" style={{ alignSelf: "flex-start" }}>
              Создать эскадрилью
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--muted)", fontFamily: "ui-monospace, monospace", letterSpacing: 2, textTransform: "uppercase", fontSize: 12 }}>Загрузка эскадрилий...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 16, display: "flex", justifyContent: "center" }}>
            <IconSquadron size={48} color="#9ca3af" />
          </div>
          <h3 style={{ color: "var(--text)", marginBottom: 8 }}>Эскадрилий не найдено</h3>
          <p>Создайте первую эскадрилью для координации строительства</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtered.map((s) => (
            <div
              key={s.id}
              className="card"
              style={{
                borderLeft: `3px solid ${s.color}`,
                padding: "16px 20px",
                transition: "border-color 0.2s, transform 0.15s",
                cursor: "default",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = "translateY(0)"; }}
            >
              {/* Верхняя строка: название + статус + действия */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 200 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  <div>
                    <Link href={`/squadrons/${s.id}`} style={{ color: s.color, fontWeight: 600, textDecoration: "none", fontSize: 16 }}>
                      {s.name}
                    </Link>
                    {s.tag && <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 8, fontFamily: "ui-monospace, monospace" }}>[{s.tag}]</span>}
                    {s.is_open_recruitment && (
                      <span style={{
                        marginLeft: 8, padding: "1px 6px", borderRadius: 2, fontSize: 10,
                        background: "rgba(34,197,94,0.15)", color: "#22c55e", fontWeight: 600,
                        fontFamily: "ui-monospace, monospace", letterSpacing: 0.5, textTransform: "uppercase",
                      }}>
                        Свободный набор
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                  <span style={{
                    padding: "3px 10px", borderRadius: 2, fontSize: 11,
                    background: `${statusColor(s.status)}15`, color: statusColor(s.status),
                    fontWeight: 600, fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase",
                  }}>
                    {statusLabel(s.status)}
                  </span>
                  {mySquadronId === s.id && (
                    <span style={{
                      padding: "3px 10px", borderRadius: 2, background: "rgba(34,197,94,0.15)",
                      color: "#22c55e", fontSize: 11, fontWeight: 600,
                      fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase",
                    }}>
                      В составе
                    </span>
                  )}
                </div>
              </div>

              {/* Описание */}
              {s.description && (
                <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 10px 22px", lineHeight: 1.5, maxWidth: 700 }}>
                  {s.description}
                </p>
              )}

              {/* Бейджи с параметрами */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", margin: "0 0 12px 22px", alignItems: "center" }}>
                {s.allegiance && (
                  <span style={badgeStyle} title="Принадлежность">
                    {allegianceIcon(s.allegiance)} {s.allegiance}
                  </span>
                )}
                {s.power && (
                  <span style={{ ...badgeStyle, borderColor: "#e67e2255", color: "#f39c12" }} title="Сила (Power)">
                    <IconPower size={12} color="#f39c12" /> {s.power}
                  </span>
                )}
                {s.activity_type && s.activity_type !== "Mixed" && (
                  <span style={{ ...badgeStyle, borderColor: "#60a5fa55", color: "#60a5fa" }} title="Тип активности">
                    <IconActivity size={12} color="#60a5fa" /> {s.activity_type}
                  </span>
                )}
                {s.home_system && (
                  <span style={{ ...badgeStyle, borderColor: "#c4b5fd55", color: "#c4b5fd" }} title="Домашняя система">
                    <IconHomeSystem size={12} color="#c4b5fd" /> {s.home_system}
                  </span>
                )}
                {s.language && (
                  <span style={badgeStyle} title="Язык">
                    <IconLanguage size={12} color="#9ca3af" /> {s.language}
                  </span>
                )}
                {s.timezone && (
                  <span style={badgeStyle} title="Часовой пояс">
                    <IconTimezone size={12} color="#9ca3af" /> {s.timezone}
                  </span>
                )}
                {s.discord_url && (
                  <a href={s.discord_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#5865F255", color: "#5865F2", textDecoration: "none" }} title="Discord">
                    <IconDiscord size={12} color="#5865F2" /> Discord
                  </a>
                )}
                {s.website_url && (
                  <a href={s.website_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: "#22c55e55", color: "#22c55e", textDecoration: "none" }} title="Веб-сайт">
                    <IconWebsite size={12} color="#22c55e" /> Сайт
                  </a>
                )}
              </div>

              {/* Нижняя строка: статистика + кнопки */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginLeft: 22 }}>
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
                  <span><IconMembers size={12} color="#9ca3af" /> {s.member_count || 0} / {s.member_limit || SQUADRON_MEMBER_LIMIT}</span>
                  <span><IconProjects size={12} color="#9ca3af" /> {s.project_count || 0} проектов</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Link href={`/squadrons/${s.id}`} className="btn" style={{ fontSize: 11, padding: "6px 12px" }}>
                    Подробнее
                  </Link>
                  {s.status === "recruiting" && mySquadronId !== s.id && (
                    <button
                      onClick={() => applyToSquadron(s.id)}
                      className="btn btn-orange"
                      style={{ fontSize: 11, padding: "6px 12px" }}
                      disabled={!!mySquadronId}
                    >
                      Подать заявку
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

const fieldLabel: React.CSSProperties = {
  color: "var(--muted)", fontSize: 11, display: "block", marginBottom: 4,
  fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase",
};

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
