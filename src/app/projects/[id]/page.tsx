"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

 type ProjectMember = {
  user_id: string;
  role: string;
  callsign: string | null;
  profile: { cmdr_name: string; avatar_url: string | null; squadron: string | null } | null;
};

 type ProjectSystem = {
  id: number;
  system_name: string;
  planned_status: string;
  target_date: string | null;
  sort_order: number;
  assigned_to: string | null;
  notes: string | null;
  route_system_id: number | null;
  assignee: { cmdr_name: string } | null;
  route_system: { status: string; progress: number; x: number; y: number; z: number } | null;
  hub: { status: string; progress: number; x: number; y: number; z: number } | null;
  x?: number; y?: number; z?: number;
};

 type RoutePoint = {
  system_name: string;
  x: number;
  y: number;
  z: number;
  status: string;
  progress: number;
  is_hub: boolean;
  sort_order: number;
};

 type ProgressState = { current: number; total: number; phase: string; pct: number } | null;
 type EdsmProgress = { current: number; total: number; systemName: string } | null;

const statusLabel = (s: string) => {
  switch (s) {
    case "active": return "Активен";
    case "paused": return "Приостановлен";
    case "completed": return "Завершён";
    case "archived": return "Архив";
    default: return s;
  }
};

const sysStatusLabel = (s: string) => {
  switch (s) {
    case "done": return "Готово";
    case "building": return "Строится";
    case "planned": return "Запланировано";
    case "preparing": return "Подготовка";
    case "on_hold": return "На паузе";
    default: return s;
  }
};

const sysStatusClass = (s: string) => {
  if (s === "done") return "status-done";
  if (s === "building") return "status-building";
  return "status-planned";
};

export default function ProjectPage() {
  const params = useParams();
  const id = parseInt(params.id as string);

  const [user, setUser] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "members" | "manage" | "route">("overview");
  const [canEdit, setCanEdit] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [squadronPilots, setSquadronPilots] = useState<any[]>([]);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [progress, setProgress] = useState<ProgressState>(null);
  const [edsmLoading, setEdsmLoading] = useState(false);
  const [edsmProgress, setEdsmProgress] = useState<EdsmProgress>(null);
  const [debugInfo, setDebugInfo] = useState<any>(null);

  const project = data?.project;
  const members: ProjectMember[] = data?.members || [];
  const systems: ProjectSystem[] = data?.systems || [];
  const route: RoutePoint[] = data?.route || [];

  const load = async () => {
    setLoading(true);
    setDebugInfo(null);
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    setUser(currentUser);

    let apiData: any = null;
    try {
      const res = await fetch(`/api/projects/${id}`);
      apiData = await res.json();
      if (apiData._debug) setDebugInfo(apiData._debug);
    } catch (e: any) {
      console.error("API fetch failed:", e);
    }

    let finalMembers = apiData?.members || [];
    let finalSystems = apiData?.systems || [];
    let finalProject = apiData?.project;
    let finalRoute = apiData?.route || [];

    if (finalProject && (finalMembers.length === 0 || finalSystems.length === 0)) {
      try {
        const [{ data: fbMembers }, { data: fbSystems }, { data: fbRoute }] = await Promise.all([
          supabase
            .from("project_members")
            .select("*, profile:profiles(cmdr_name, avatar_url, squadron)")
            .eq("project_id", id)
            .order("role"),
          supabase
            .from("project_systems")
            .select(`
              *,
              assignee:profiles!assigned_to(cmdr_name),
              route_system:route_systems(status, progress, x, y, z),
              hub:hubs(status, progress, x, y, z)
            `)
            .eq("project_id", id)
            .order("sort_order"),
          supabase.rpc("get_project_route", { project_id: id }),
        ]);
        if (fbMembers?.length) finalMembers = fbMembers;
        if (fbSystems?.length) finalSystems = fbSystems;
        if (fbRoute) finalRoute = fbRoute;
      } catch (e) {
        console.error("Fallback fetch failed:", e);
      }
    }

    if (finalProject) {
      let enrichedSystems = finalSystems;
      try {
        const { data: routeSystems } = await supabase
          .from("route_systems")
          .select("system_name, x, y, z, status, progress, is_hub")
          .order("sort_order");
        if (routeSystems && enrichedSystems.length) {
          const routeMap = new Map(routeSystems.map((r: any) => [r.system_name, r]));
          enrichedSystems = enrichedSystems.map((s: any) => {
            const r = routeMap.get(s.system_name);
            return r ? { ...s, ...r } : s;
          });
        }
      } catch (e) { /* ignore */ }

      if (finalMembers.length) {
        const userIds = finalMembers.map((m: any) => m.user_id);
        try {
          const { data: sqData } = await supabase
            .from("squadron_member_detail")
            .select("user_id, squadron_name")
            .in("user_id", userIds);
          if (sqData) {
            const squadronMap = new Map<string, string>();
            for (const row of sqData) {
              if (!squadronMap.has(row.user_id)) {
                squadronMap.set(row.user_id, row.squadron_name);
              }
            }
            finalMembers = finalMembers.map((m: any) => ({
              ...m,
              profile: {
                ...m.profile,
                squadron: m.profile?.squadron || squadronMap.get(m.user_id) || "—",
              },
            }));
          }
        } catch (e) { /* ignore */ }
      }

      setData({ project: finalProject, members: finalMembers, systems: enrichedSystems, route: finalRoute });
      setDescDraft(finalProject.description || "");

      if (currentUser) {
        const member = finalMembers.find((m: ProjectMember) => m.user_id === currentUser.id);
        setIsMember(!!member);

        let canEditProject = member?.role === "leader" || member?.role === "officer";
        if (!canEditProject && finalProject?.squadron_id) {
          const { data: sqPerm } = await supabase
            .from("squadron_member_detail")
            .select("can_manage_projects")
            .eq("squadron_id", finalProject.squadron_id)
            .eq("user_id", currentUser.id)
            .single();
          canEditProject = !!sqPerm?.can_manage_projects;
        }
        setCanEdit(canEditProject);
      }

      if (finalProject?.squadron_id) {
        const sqRes = await fetch(`/api/squadrons/${finalProject.squadron_id}`);
        const sqJson = await sqRes.json();
        setSquadronPilots(sqJson.members || []);
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const syncAllProgress = async () => {
    setProgress({ current: 0, total: systems.length, phase: "Синхронизация...", pct: 0 });
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i];
      setProgress({ current: i + 1, total: systems.length, phase: s.system_name, pct: Math.round(((i + 1) / systems.length) * 100) });
      try {
        await fetch("/api/route/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system_name: s.system_name }),
        });
      } catch (e) { console.error(e); }
    }
    setProgress(null);
    load();
  };

  const fetchEdsmCoords = async () => {
    if (!systems.length) return;
    const missing = systems.filter((s) => s.x == null || s.y == null || s.z == null);
    if (!missing.length) { alert("У всех систем уже есть координаты"); return; }

    setEdsmLoading(true);
    setEdsmProgress({ current: 0, total: missing.length, systemName: "Подготовка..." });

    try {
      const res = await fetch("/api/edsm/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: missing.map((s) => s.system_name) }),
      });
      const json = await res.json();
      let updated = 0;

      for (let i = 0; i < missing.length; i++) {
        const s = missing[i];
        setEdsmProgress({ current: i + 1, total: missing.length, systemName: s.system_name });

        const coords = json.results?.[s.system_name];
        if (coords) {
          let { data: rsRecord } = await supabase
            .from("route_systems")
            .select("id")
            .eq("system_name", s.system_name)
            .single();

          if (rsRecord) {
            await supabase.from("route_systems").update({
              x: coords.x, y: coords.y, z: coords.z,
            }).eq("system_name", s.system_name);
          } else {
            const { data: newRs } = await supabase.from("route_systems").insert({
              system_name: s.system_name,
              x: coords.x, y: coords.y, z: coords.z,
              sort_order: 0,
            }).select("id").single();
            if (newRs) rsRecord = newRs;
          }

          if (rsRecord && !s.route_system_id) {
            await supabase.from("project_systems")
              .update({ route_system_id: rsRecord.id })
              .eq("id", s.id);
          }
          updated++;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      alert(`Обновлено координат: ${updated} из ${missing.length}`);
      load();
    } catch (e: any) {
      alert("Ошибка EDSM: " + e.message);
    } finally {
      setEdsmLoading(false);
      setEdsmProgress(null);
    }
  };

  const addBulkSystems = async (names: string[]) => {
    const { data: routeSystems } = await supabase
      .from("route_systems")
      .select("id, system_name")
      .in("system_name", names.map((n) => n.trim()));
    const routeMap = new Map((routeSystems || []).map((r: any) => [r.system_name.toLowerCase(), r.id]));

    const rows = names.map((n, i) => ({
      project_id: id,
      system_name: n.trim(),
      route_system_id: routeMap.get(n.trim().toLowerCase()) || null,
      sort_order: systems.length + i + 1,
    }));

    const { error } = await supabase.from("project_systems").insert(rows);
    if (error) alert(error.message);
    else load();
  };

  const assignPilot = async (user_id: string) => {
    const res = await fetch(`/api/projects/${id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });
    if (res.ok) load();
    else { const j = await res.json(); alert(j.error); }
  };

  const removePilot = async (user_id: string) => {
    if (!confirm("Удалить пилота из проекта?")) return;
    await fetch(`/api/projects/${id}/assign`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });
    load();
  };

  const saveDescription = async () => {
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: descDraft }),
    });
    if (res.ok) {
      setEditingDesc(false);
      load();
    }
  };

  const focusSystemOnMap = useCallback((system: ProjectSystem) => {
    if (system.x == null || system.y == null || system.z == null) return;
    const point: RoutePoint = {
      system_name: system.system_name,
      x: system.x,
      y: system.y,
      z: system.z,
      status: system.planned_status,
      progress: 0,
      is_hub: false,
      sort_order: 0,
    };
    window.dispatchEvent(new CustomEvent('atlas-focus-route-point', { detail: point }));
  }, []);

  const removeSystemFromRoute = async (systemId: string | number, systemName: string) => {
    if (!confirm(`Удалить "${systemName}" из маршрута?`)) return;
    const res = await fetch(`/api/projects/${id}/systems`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_id: systemId }),
    });
    if (res.ok) load();
    else alert("Ошибка удаления");
  };

  const clearRoute = async () => {
    if (!confirm("Очистить ВЕСЬ маршрут проекта? Это удалит все системы.")) return;
    const res = await fetch(`/api/projects/${id}/systems`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) load();
    else alert("Ошибка очистки маршрута");
  };

  if (loading) return <div style={{ padding: 40, textAlign: "center" }}>Загрузка...</div>;
  if (!project) return <div style={{ padding: 40, textAlign: "center" }}>Проект не найден</div>;

  const doneCount = systems.filter((s: any) => s.planned_status === "done").length;
  const buildingCount = systems.filter((s: any) => s.planned_status === "building").length;
  const total = systems.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="card" style={{ width: "100%" }}>
      {/* Debug panel */}
      {debugInfo && (members.length === 0 || systems.length === 0) && (
        <div style={{ background: "#323538", border: "1px solid #e67e22", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#f39c12" }}>
          <strong>&#9888; Отладка:</strong> API вернул пустые данные.
          <div style={{ marginTop: 4, color: "#9ca3af" }}>
            hasServiceKey: {debugInfo.hasServiceKey ? "&#9989;" : "&#10060;"} |
            members: {debugInfo.membersCount} |
            systems: {debugInfo.systemsCount}
            {debugInfo.membersError && <div style={{ color: "#e74c3c" }}>membersError: {debugInfo.membersError}</div>}
            {debugInfo.systemsError && <div style={{ color: "#e74c3c" }}>systemsError: {debugInfo.systemsError}</div>}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="project-detail-header">
        <div className="project-detail-title">
          <div className="color-block" style={{ background: project.color }} />
          <div>
            <h1 style={{ color: project.color }}>{project.name}</h1>
            {editingDesc ? (
              <div style={{ marginTop: 8 }}>
                <textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  className="bulk-textarea"
                  style={{ minHeight: 80 }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={saveDescription} className="btn btn-cyan" style={{ fontSize: 12 }}>
                    Сохранить
                  </button>
                  <button
                    onClick={() => { setEditingDesc(false); setDescDraft(project.description || ""); }}
                    style={{ fontSize: 12 }}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                <p style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1.6, flex: 1, margin: 0 }}>
                  {project.description || "Описание не задано"}
                </p>
                {canEdit && (
                  <button
                    onClick={() => setEditingDesc(true)}
                    style={{ fontSize: 11, padding: "4px 10px", background: "#3a3d40", color: "#eeeeee", borderRadius: 2, flexShrink: 0 }}
                  >
                    &#9998; Редактировать
                  </button>
                )}
              </div>
            )}
            <div className="project-detail-meta">
              <span>&#9679; {statusLabel(project.status)}</span>
              <span>&#128100; {members.length} пилотов</span>
              <span>&#127759; {total} систем</span>
              {project.squadron_id && (
                <Link href={`/squadrons/${project.squadron_id}`} style={{ color: "var(--orange)" }}>
                  &#128737; Эскадрилья
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="project-detail-actions">
          <Link href={`/atlas?project=${id}`} className="btn btn-cyan">
            &#9733; Атлас
          </Link>
          {canEdit && (
            <button
              onClick={async () => {
                if (!confirm("Удалить проект?")) return;
                await fetch(`/api/projects/${id}`, { method: "DELETE" });
                window.location.href = "/projects";
              }}
              className="btn danger-btn"
            >
              Удалить
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-box">
          <div className="num">{total}</div>
          <div className="lbl">Систем</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: "#22c55e" }}>{doneCount}</div>
          <div className="lbl">Готово</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: "#e67e22" }}>{buildingCount}</div>
          <div className="lbl">Строится</div>
        </div>
        <div className="stat-box">
          <div className="num">{members.length}</div>
          <div className="lbl">Участников</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: project.color }}>{pct}%</div>
          <div className="lbl">Готовности</div>
        </div>
      </div>

      {total > 0 && (
        <div className="progress-thin" style={{ marginBottom: 20, height: 6 }}>
          <div className="fill" style={{ width: `${pct}%`, background: project.color }} />
        </div>
      )}

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={activeTab === "overview" ? "tab tab-active" : "tab"} onClick={() => setActiveTab("overview")}>
          Обзор
        </button>
        <button className={activeTab === "members" ? "tab tab-active" : "tab"} onClick={() => setActiveTab("members")}>
          Участники
        </button>
        <button className={activeTab === "route" ? "tab tab-active" : "tab"} onClick={() => setActiveTab("route")}>
          Маршрут
        </button>
        {canEdit && (
          <button className={activeTab === "manage" ? "tab tab-active" : "tab"} onClick={() => setActiveTab("manage")}>
            Управление
          </button>
        )}
      </div>

      {/* Progress overlay */}
      {progress && (
        <div className="panel-box">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13 }}>{progress.phase}</span>
            <span style={{ fontSize: 13, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
              {progress.current} / {progress.total}
            </span>
          </div>
          <div className="progress-thin" style={{ height: 6 }}>
            <div className="fill" style={{ width: `${progress.pct}%`, background: "#22c55e" }} />
          </div>
        </div>
      )}

      {/* Overview tab */}
      {activeTab === "overview" && (
        <div>
          <h2 style={{ fontSize: 14, letterSpacing: 2, marginBottom: 12 }}>Системы проекта</h2>
          {systems.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>Системы ещё не добавлены</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {systems.map((s: any) => (
                <div
                  key={s.id}
                  className={`system-row ${sysStatusClass(s.planned_status)}`}
                  onClick={() => focusSystemOnMap(s)}
                  style={{ cursor: 'pointer' }}
                  title="Кликните для фокуса на карте"
                >
                  <span className="sys-name">{s.system_name}</span>
                  <span className="sys-meta">
                    <span>{sysStatusLabel(s.planned_status)}</span>
                    {s.target_date && <span>&#8594; {new Date(s.target_date).toLocaleDateString("ru-RU")}</span>}
                    {s.assignee?.cmdr_name && <span style={{ color: "#60a5fa" }}>@{s.assignee.cmdr_name}</span>}
                  </span>
                  <div className="sys-links">
                    <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(s.system_name)}`} target="_blank" rel="noreferrer">
                      RC
                    </a>
                    <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(s.system_name)}`} target="_blank" rel="noreferrer">
                      EDSM
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Members tab */}
      {activeTab === "members" && (
        <div>
          <div className="panel-box">
            <h3>Участники проекта</h3>
            {members.length === 0 ? (
              <p className="empty">Участников пока нет</p>
            ) : (
              <div>
                {members.map((m: ProjectMember) => (
                  <div key={m.user_id} className="member-row">
                    {m.profile?.avatar_url ? (
                      <img src={m.profile.avatar_url} alt="" className="member-avatar" />
                    ) : (
                      <div className="member-avatar-placeholder" />
                    )}
                    <Link
                      href={`/cmdr/${encodeURIComponent(m.profile?.cmdr_name || "")}`}
                      className="member-name"
                      style={{ textDecoration: "none" }}
                    >
                      {m.profile?.cmdr_name || "Unknown"}
                    </Link>
                    <span className={`member-role ${m.role}`}>
                      {m.role === "leader" ? "Лидер" : m.role === "officer" ? "Офицер" : "Участник"}
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                      {m.callsign || "—"}
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>
                      {m.profile?.squadron || "—"}
                    </span>
                    {canEdit && m.role !== "leader" && (
                      <button
                        onClick={() => removePilot(m.user_id)}
                        className="btn danger-btn"
                        style={{ fontSize: 11, padding: "4px 10px" }}
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {canEdit && data?.project?.squadron_id && (
            <div className="panel-box">
              <h3>Назначить пилота из эскадрильи</h3>
              {squadronPilots.filter((sp: any) => !members.find((m: any) => m.user_id === sp.user_id)).length === 0 ? (
                <p className="empty">Все пилоты эскадрильи уже в проекте</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {squadronPilots
                    .filter((sp: any) => !members.find((m: any) => m.user_id === sp.user_id))
                    .map((sp: any) => (
                      <div key={sp.user_id} className="member-row">
                        {sp.avatar_url ? (
                          <img src={sp.avatar_url} alt="" className="member-avatar" />
                        ) : (
                          <div className="member-avatar-placeholder" />
                        )}
                        <span className="member-name">{sp.cmdr_name || "Unknown"}</span>
                        <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                          {sp.rank_name}
                        </span>
                        <button
                          onClick={() => assignPilot(sp.user_id)}
                          className="btn btn-cyan"
                          style={{ fontSize: 11, padding: "4px 12px" }}
                        >
                          Назначить
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Route tab */}
      {activeTab === "route" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ fontSize: 14, letterSpacing: 2, margin: 0 }}>Маршрут проекта</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={fetchEdsmCoords}
                disabled={edsmLoading}
                className="btn success-btn"
                style={{ fontSize: 11, padding: "6px 14px" }}
              >
                {edsmLoading ? "⏳ Загрузка..." : "📡 Координаты с EDSM"}
              </button>
              {canEdit && systems.length > 0 && (
                <button
                  onClick={clearRoute}
                  className="btn danger-btn"
                  style={{ fontSize: 11, padding: "6px 14px" }}
                >
                  🗑 Очистить маршрут
                </button>
              )}
            </div>
          </div>

          {edsmProgress && (
            <div className="panel-box">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>
                  Загрузка координат: <strong style={{ color: "var(--text)" }}>{edsmProgress.systemName}</strong>
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "ui-monospace, monospace" }}>
                  {edsmProgress.current} / {edsmProgress.total}
                </span>
              </div>
              <div className="progress-thin" style={{ height: 6 }}>
                <div
                  className="fill"
                  style={{
                    width: `${edsmProgress.total > 0 ? (edsmProgress.current / edsmProgress.total) * 100 : 0}%`,
                    background: "#22c55e",
                  }}
                />
              </div>
            </div>
          )}

          {route.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>Маршрут пуст</p>
          ) : (
            <div className="panel-box" style={{ padding: 0 }}>
              {route.map((r: RoutePoint, i: number) => (
                <div
                  key={i}
                  className="route-row"
                  onClick={() => focusSystemOnMap({
                    id: i,
                    system_name: r.system_name,
                    planned_status: r.status,
                    x: r.x,
                    y: r.y,
                    z: r.z,
                  } as any)}
                  style={{ cursor: 'pointer' }}
                  title="Кликните для фокуса на карте"
                >
                  <span className="route-idx">{i + 1}</span>
                  <span className="route-name">{r.system_name}</span>
                  <span className="route-coords">
                    {r.x != null ? `${r.x.toFixed(1)}, ${r.y.toFixed(1)}, ${r.z.toFixed(1)}` : "—"}
                  </span>
                  <span className="route-status" style={{ color: r.status === "done" ? "#22c55e" : r.status === "building" ? "#e67e22" : "var(--muted)" }}>
                    {r.status === "done" ? "✅" : r.status === "building" ? "🚧" : "⏳"}
                  </span>
                  <div className="sys-links">
                    <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(r.system_name)}`} target="_blank" rel="noreferrer">
                      RC
                    </a>
                    <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(r.system_name)}`} target="_blank" rel="noreferrer">
                      EDSM
                    </a>
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => {
                        const sys = systems.find((s: any) => s.system_name === r.system_name);
                        if (sys) removeSystemFromRoute(sys.id, sys.system_name);
                      }}
                      className="btn danger-btn"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      title="Удалить из маршрута"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manage tab */}
      {activeTab === "manage" && canEdit && (
        <div>
          <div className="panel-box">
            <h3>Массовое добавление систем</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
              Вставьте список систем (по одной на строку)
            </p>
            <textarea
              id="bulk-systems"
              className="bulk-textarea"
              placeholder="Sol&#10;Alpha Centauri&#10;..."
            />
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => {
                  const el = document.getElementById("bulk-systems") as HTMLTextAreaElement;
                  const names = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
                  if (names.length) addBulkSystems(names);
                }}
                className="btn btn-cyan"
                style={{ fontSize: 12 }}
              >
                Добавить системы
              </button>
            </div>
          </div>

          <button onClick={syncAllProgress} className="btn btn-orange" style={{ marginBottom: 16, fontSize: 12 }}>
            &#128260; Синхронизировать прогресс
          </button>

          <h2 style={{ fontSize: 14, letterSpacing: 2, marginBottom: 12 }}>Системы</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {systems.map((s: any) => (
              <div key={s.id} className={`system-row ${sysStatusClass(s.planned_status)}`}>
                <span className="sys-name">{s.system_name}</span>
                <select
                  value={s.planned_status}
                  onChange={async (e) => {
                    await supabase.from("project_systems").update({ planned_status: e.target.value }).eq("id", s.id);
                    load();
                  }}
                  className="inline-select"
                >
                  <option value="planned">Запланировано</option>
                  <option value="preparing">Подготовка</option>
                  <option value="building">Строится</option>
                  <option value="done">Готово</option>
                  <option value="on_hold">На паузе</option>
                </select>
                <button
                  onClick={async () => {
                    await supabase.from("project_systems").delete().eq("id", s.id);
                    load();
                  }}
                  className="btn danger-btn"
                  style={{ fontSize: 11, padding: "4px 10px" }}
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
