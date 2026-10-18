"use client";

import { updateSystemCoordinates } from "@/lib/updateSystemCoordinates";
import { readSystemCoordinates } from "@/lib/systemCoordinateTypes";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase, authFetch } from "@/lib/supabaseClient";
import Link from "next/link";
import { systemKey, systemPageHref } from "@/lib/systemIdentity";
import { IconClock, IconSatellite, IconTrash, IconCheckCircle, IconConstruction, IconX } from "@/components/Icons";
import Avatar from "@/components/Avatar";

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

const formatCoordinates = (system: { x?: unknown; y?: unknown; z?: unknown }) => {
  const coords = readSystemCoordinates(system);
  const coordinates = coords ? [coords.x, coords.y, coords.z] : [];
  return coords && coordinates.every(Number.isFinite)
    ? coordinates.map((value) => value.toFixed(2)).join(", ")
    : "Координаты не загружены";
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
  // Прогресс каждой системы тем же расчётом, что у «Проектов систем» и карточки
  // системы: кэш Raven + площадки из журналов пилотов (GET /api/projects/[id]/progress).
  const [systemProgress, setSystemProgress] = useState<Record<string, { progress: number | null; status: string; sitesComplete: number; sitesActive: number; remaining: number | null }>>({});

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
            .select("*")
            .eq("project_id", id)
            .order("role"),
          supabase
            .from("project_systems")
            .select(`
              *,
              route_system:route_systems(status, progress, x, y, z),
              hub:hubs(status, progress, x, y, z)
            `)
            .eq("project_id", id)
            .order("sort_order"),
          supabase.rpc("get_project_route", { project_id: id }),
        ]);
        // Имена участников и ответственных — из публичного представления
        // профилей. Встроенная связь `profiles(...)` после ужесточения RLS
        // (20261015000000) видна только владельцу строки и персоналу, а
        // public_profiles читается всеми и не содержит приватных колонок.
        const profileIds = [...new Set([
          ...(fbMembers || []).map((m: any) => m.user_id),
          ...(fbSystems || []).map((s: any) => s.assigned_to),
        ].filter(Boolean))];
        const profileRows = profileIds.length
          ? ((await supabase
              .from("public_profiles")
              .select("id, cmdr_name, avatar_url, squadron")
              .in("id", profileIds)).data || [])
          : [];
        const profileMap = new Map(profileRows.map((p: any) => [p.id, p]));
        if (fbMembers?.length) {
          finalMembers = fbMembers.map((m: any) => ({ ...m, profile: profileMap.get(m.user_id) ?? null }));
        }
        if (fbSystems?.length) {
          finalSystems = fbSystems.map((s: any) => ({ ...s, assignee: profileMap.get(s.assigned_to) ?? null }));
        }
        if (fbRoute) finalRoute = fbRoute;
      } catch (e) {
        console.error("Fallback fetch failed:", e);
      }
    }

    if (finalProject) {
      // The project systems API already enriches legacy rows with global map
      // data while preserving project_systems coordinates as authoritative.
      // Do not merge route_systems here: spreading a global row over the
      // project row made EDSM coordinates appear present and prevented the
      // project updater from filling missing coordinates.

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

      setData({ project: finalProject, members: finalMembers, systems: finalSystems, route: finalRoute });
      setDescDraft(finalProject.description || "");

      if (currentUser) {
        const member = finalMembers.find((m: ProjectMember) => m.user_id === currentUser.id);
        setIsMember(!!member);

        let canEditProject = finalProject?.created_by === currentUser.id || member?.role === "leader" || member?.role === "officer";
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

  const systemsCount = systems.length;
  useEffect(() => {
    if (!systemsCount) return;
    let cancelled = false;
    fetch(`/api/projects/${id}/progress`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload || !Array.isArray(payload.systems)) return;
        const next: Record<string, { progress: number | null; status: string; sitesComplete: number; sitesActive: number; remaining: number | null }> = {};
        for (const row of payload.systems) next[String(row.key)] = row;
        setSystemProgress(next);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, systemsCount, data]);

  const syncAllProgress = async () => {
    if (!systems.length) return;

    // The project endpoint owns project_systems notes and now updates the
    // shared map cache as well. The old loop posted { system_name } to the
    // route endpoint, whose contract requires an ids array, so every request
    // was rejected and the map was left with stale planned points.
    setProgress({ current: 0, total: systems.length, phase: "Синхронизация RavenColonial...", pct: 5 });
    try {
      const response = await fetch(`/api/projects/${id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Не удалось синхронизировать прогресс");
      }
      setProgress({ current: payload.synced ?? systems.length, total: systems.length, phase: "Кэш карты обновлён", pct: 100 });
    } catch (error: any) {
      console.error(error);
      alert(error?.message || "Не удалось синхронизировать прогресс");
    } finally {
      // Keep the completed state visible briefly so the action does not look
      // like a no-op when the server answers quickly.
      window.setTimeout(() => setProgress(null), 250);
      load();
    }
  };

  const fetchSystemCoords = async () => {
    if (!canEdit) return;
    setEdsmLoading(true);
    setEdsmProgress({ current: 0, total: 0, systemName: "Загрузка полного списка проекта..." });
    try {
      const listResponse = await fetch(`/api/projects/${id}/systems?coordinates_only=1`, { cache: "no-store" });
      const listData = await listResponse.json().catch(() => ({}));
      if (!listResponse.ok || !Array.isArray(listData.systems)) throw new Error(listData.error || "Не удалось загрузить полный список проекта");
      const allSystems: ProjectSystem[] = listData.systems;
      const missing = allSystems.filter(row => !readSystemCoordinates(row));
      if (!missing.length) { alert(allSystems.length ? "У всех систем уже есть координаты" : "В проекте пока нет систем"); return; }
      setEdsmProgress({ current: 0, total: missing.length, systemName: "EDSM / Spansh..." });
      const result = await updateSystemCoordinates(allSystems, async (system, coords) => {
        // Project coordinates belong exclusively to project_systems.
        const response = await authFetch(`/api/projects/${id}/systems`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system_id: system.id, ...coords }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${response.status}`);
        }
      }, { endpoint: "/api/edsm/batch", onProgress: (current, total, systemName) => setEdsmProgress({ current, total, systemName }) });
      alert(`Обновлено координат: ${result.updated} из ${result.total}. EDSM: ${result.sources.edsm}, Spansh: ${result.sources.spansh + result.sources.spansh_catalog}. Не найдены: ${result.unresolved}, ошибок записи: ${result.failed}. ${result.errors.join(' ')} ${result.warnings.join(' ')}`);
    } catch (error: any) { alert("Ошибка получения координат: " + error.message); }
    finally { setEdsmLoading(false); setEdsmProgress(null); load(); }
  };

  const addBulkSystems = async (names: string[]) => {
    const rows = names.map((n, i) => ({
      project_id: id,
      system_name: n.trim(),
      // Squadron project systems are independent from the global route.
      route_system_id: null,
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
    else { const data = await res.json().catch(() => ({})); alert(`Ошибка удаления: ${data.error || res.statusText}`); }
  };

  const clearRoute = async () => {
    if (!confirm("Очистить ВЕСЬ маршрут проекта? Это удалит все системы.")) return;
    const res = await fetch(`/api/projects/${id}/systems`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) load();
    else { const data = await res.json().catch(() => ({})); alert(`Ошибка очистки маршрута: ${data.error || res.statusText}`); }
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
                    {(() => {
                      const unified = systemProgress[systemKey(s.system_name)];
                      if (!unified || unified.progress == null) return null;
                      const sites = unified.sitesComplete + unified.sitesActive;
                      return (
                        <span
                          className="sys-unified-progress"
                          title={`Тот же расчёт, что в «Проектах систем»: площадок ${sites} (готово ${unified.sitesComplete})${unified.remaining != null ? `, осталось ${unified.remaining.toLocaleString("ru-RU")} т` : ""}`}
                          style={{ color: unified.status === "done" ? "#22c55e" : "#e67e22", fontFamily: "ui-monospace, monospace" }}
                        >
                          {unified.progress.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%
                        </span>
                      );
                    })()}
                    {s.target_date && <span>&#8594; {new Date(s.target_date).toLocaleDateString("ru-RU")}</span>}
                    {s.assignee?.cmdr_name && <span style={{ color: "#60a5fa" }}>@{s.assignee.cmdr_name}</span>}
                  </span>
                  <span className="project-system-coordinates" title="Координаты проекта">
                    {formatCoordinates(s)}
                  </span>
                  <div className="sys-links">
                    <Link
                      className="project-link-button"
                      href={systemPageHref(s.system_name)}
                      onClick={(event) => event.stopPropagation()}
                      title="Карточка системы: стройки, фракции, PowerPlay, станции, авианосцы"
                    >
                      Система
                    </Link>
                    <a
                      className="project-link-button"
                      href={`https://ravencolonial.com/#sys=${encodeURIComponent(s.system_name)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      RC
                    </a>
                    <a
                      className="project-link-button"
                      href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(s.system_name)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
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
                      <Avatar url={m.profile.avatar_url} name={m.profile.cmdr_name} size={32} className="member-avatar" />
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
                          <Avatar url={sp.avatar_url} name={sp.cmdr_name} size={32} className="member-avatar" />
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
                onClick={fetchSystemCoords}
                disabled={edsmLoading || !canEdit}
                className="btn success-btn"
                style={{ fontSize: 11, padding: "6px 14px" }}
              >
                {edsmLoading ? <><IconClock size={14} /> Загрузка...</> : <><IconSatellite size={14} /> Координаты EDSM / Spansh</>}
              </button>
              {canEdit && systems.length > 0 && (
                <button
                  onClick={clearRoute}
                  className="btn danger-btn"
                  style={{ fontSize: 11, padding: "6px 14px" }}
                >
                  <IconTrash size={14} /> Очистить маршрут
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
                    {r.status === "done" ? <IconCheckCircle size={14} /> : r.status === "building" ? <IconConstruction size={14} /> : <IconClock size={14} />}
                  </span>
                  <div className="sys-links">
                    <Link href={systemPageHref(r.system_name)} onClick={(event) => event.stopPropagation()}>
                      Система
                    </Link>
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
                      <IconX size={12} />
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
