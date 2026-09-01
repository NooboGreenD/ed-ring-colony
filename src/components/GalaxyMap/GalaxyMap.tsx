"use client";

import { Suspense, useState, useMemo, useCallback, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { useProgress, Html as DreiHtml } from "@react-three/drei";
import { GalaxyScene } from "./GalaxyScene";
import { useGalaxyData } from "./useGalaxyData";
import { eliteToThreeCentered, dist3, SAGA, SOL } from "@/lib/ed3dCanon";
import type { Hub, RoutePoint } from "./useGalaxyData";
import type { AtlasCandidate } from "@/types/atlas";
import * as THREE from "three";

function Loader() {
  const { progress } = useProgress();
  return (
    <DreiHtml center>
      <div className="map-loader">
        <div className="map-loader-spinner" />
        <div className="map-loader-text">Загрузка галактики...</div>
        <div className="map-loader-percent">{progress.toFixed(0)}%</div>
      </div>
    </DreiHtml>
  );
}

type NavTab = "hubs" | "route" | "atlas";

const STATUS_LABELS: Record<string, string> = {
  planned: "Запланирован",
  building: "Строительство",
  done: "Завершён",
};

const STATUS_COLORS: Record<string, string> = {
  planned: "#888888",
  building: "#e67e22",
  done: "#4caf50",
};

const ATLAS_TYPE_LABELS: Record<string, string> = {
  earth_like: "🌍 Earth-like",
  water_world: "💧 Water",
  ammonia: "🟠 Ammonia",
  terraformable: "🌱 Terraformable",
  neutron_star: "⚡ Neutron",
  black_hole: "🕳️ Black Hole",
  white_dwarf: "⚪ White Dwarf",
  wolf_rayet: "🔥 Wolf-Rayet",
  herbig_ae_be: "⭐ Herbig",
  t_tauri: "⭐ T Tauri",
  proto_star: "⭐ Proto",
  carbon_star: "🔴 Carbon",
  supergiant: "🔴 Supergiant",
  giant: "🟠 Giant",
  rocky_atmosphere: "🪨 Rocky + Atm",
  rocky_bio: "🌿 Rocky + Bio",
};

const ATLAS_TYPE_COLORS: Record<string, string> = {
  earth_like: "#4caf50",
  water_world: "#2196f3",
  ammonia: "#ff9800",
  terraformable: "#8bc34a",
  neutron_star: "#00bcd4",
  black_hole: "#9c27b0",
  white_dwarf: "#e0e0e0",
  wolf_rayet: "#ff5722",
  rocky_atmosphere: "#a1887f",
  rocky_bio: "#66bb6a",
  default: "#9ca3af",
};

export interface GalaxyMapProps {
  atlasCandidates?: AtlasCandidate[];
  squadronRoutePoints?: RoutePoint[];
  showOnlyMainRoute?: boolean;
}

export default function GalaxyMap({ atlasCandidates = [], squadronRoutePoints = [], showOnlyMainRoute = false }: GalaxyMapProps) {
  const { hubs, allRoutePoints, error } = useGalaxyData();

  // На основной карте показываем только основной маршрут (sort_order > 0)
  // Проектные системы имеют sort_order = 0
  const displayRoutePoints = useMemo(() => {
    if (showOnlyMainRoute) {
      return allRoutePoints.filter((p) => p.sort_order > 0);
    }
    return allRoutePoints;
  }, [allRoutePoints, showOnlyMainRoute]);

  const [selectedHub, setSelectedHub] = useState<Hub | null>(null);
  const [selectedRoutePoint, setSelectedRoutePoint] = useState<RoutePoint | null>(null);
  const [selectedAtlasCandidate, setSelectedAtlasCandidate] = useState<AtlasCandidate | null>(null);

  const [navTab, setNavTab] = useState<NavTab>("hubs");
  const [navQuery, setNavQuery] = useState("");
  const [navOpen, setNavOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [atlasTypeFilter, setAtlasTypeFilter] = useState<string | null>(null);
  const [resetCamera, setResetCamera] = useState(0);

  /* ── слушаем события фокуса из sidebar ── */
  useEffect(() => {
    const onFocusCandidate = (e: Event) => {
      const candidate = (e as CustomEvent).detail as AtlasCandidate;
      setSelectedAtlasCandidate(candidate);
      setSelectedHub(null);
      setSelectedRoutePoint(null);
    };
    const onFocusRoutePoint = (e: Event) => {
      const point = (e as CustomEvent).detail as RoutePoint;
      setSelectedRoutePoint(point);
      setSelectedHub(null);
      setSelectedAtlasCandidate(null);
    };
    window.addEventListener('atlas-focus-candidate', onFocusCandidate);
    window.addEventListener('atlas-focus-route-point', onFocusRoutePoint);
    return () => {
      window.removeEventListener('atlas-focus-candidate', onFocusCandidate);
      window.removeEventListener('atlas-focus-route-point', onFocusRoutePoint);
    };
  }, []);

  const focusTarget = useMemo(() => {
    if (selectedHub) return eliteToThreeCentered(selectedHub);
    if (selectedRoutePoint) return eliteToThreeCentered(selectedRoutePoint);
    if (selectedAtlasCandidate) return eliteToThreeCentered(selectedAtlasCandidate);
    return null;
  }, [selectedHub, selectedRoutePoint, selectedAtlasCandidate]);

  const handleSelectHub = useCallback((hub: Hub | null) => {
    setSelectedHub(hub);
    if (hub) { setSelectedRoutePoint(null); setSelectedAtlasCandidate(null); }
  }, []);

  const handleSelectRoutePoint = useCallback((point: RoutePoint | null) => {
    setSelectedRoutePoint(point);
    if (point) { setSelectedHub(null); setSelectedAtlasCandidate(null); }
  }, []);

  const handleSelectAtlasCandidate = useCallback((candidate: AtlasCandidate | null) => {
    setSelectedAtlasCandidate(candidate);
    if (candidate) { setSelectedHub(null); setSelectedRoutePoint(null); }
  }, []);

  const handleNavClickHub = useCallback((hub: Hub) => {
    setSelectedHub(hub);
    setSelectedRoutePoint(null);
    setSelectedAtlasCandidate(null);
  }, []);

  const handleNavClickRoute = useCallback((point: RoutePoint) => {
    setSelectedRoutePoint(point);
    setSelectedHub(null);
    setSelectedAtlasCandidate(null);
  }, []);

  const handleNavClickAtlas = useCallback((candidate: AtlasCandidate) => {
    setSelectedAtlasCandidate(candidate);
    setSelectedHub(null);
    setSelectedRoutePoint(null);
  }, []);

  const handleResetView = useCallback(() => {
    setSelectedHub(null);
    setSelectedRoutePoint(null);
    setSelectedAtlasCandidate(null);
    setResetCamera((v) => v + 1);
  }, []);

  const filteredHubs = useMemo(() => {
    let result = hubs;
    if (statusFilter) result = result.filter((h) => h.status === statusFilter);
    const q = navQuery.trim().toLowerCase();
    if (!q) return result;
    return result.filter(
      (h) =>
        h.system_name.toLowerCase().includes(q) ||
        h.name?.toLowerCase().includes(q)
    );
  }, [hubs, navQuery, statusFilter]);

  const filteredRoute = useMemo(() => {
    let result = displayRoutePoints.filter((p) => !p.isHub);
    if (statusFilter) result = result.filter((p) => p.status === statusFilter);
    const q = navQuery.trim().toLowerCase();
    if (!q) return result;
    return result.filter((p) => p.system_name.toLowerCase().includes(q));
  }, [displayRoutePoints, navQuery, statusFilter]);

  const filteredAtlas = useMemo(() => {
    let result = atlasCandidates;
    if (atlasTypeFilter) result = result.filter((c) => c.world_type === atlasTypeFilter);
    const q = navQuery.trim().toLowerCase();
    if (!q) return result;
    return result.filter((c) => c.system_name.toLowerCase().includes(q));
  }, [atlasCandidates, navQuery, atlasTypeFilter]);

  const atlasTypes = useMemo(() => {
    const types = new Set<string>();
    atlasCandidates.forEach((c) => types.add(c.world_type));
    return Array.from(types);
  }, [atlasCandidates]);

  if (error) {
    return (
      <div className="galaxy-map-error">
        <div className="galaxy-map-error-title">Ошибка загрузки карты</div>
        <div className="galaxy-map-error-msg">{error}</div>
      </div>
    );
  }

  return (
    <div className="galaxy-map-container">
      {/* Навпанель */}
      <div className={`map-nav-panel ${navOpen ? "open" : "closed"}`}>
        <button
          className="map-nav-toggle"
          onClick={() => setNavOpen((v) => !v)}
          title={navOpen ? "Скрыть панель" : "Показать панель"}
        >
          {navOpen ? "◀" : "▶"}
        </button>

        {navOpen && (
          <div className="map-nav-content">
            <div className="map-nav-header">Навигация</div>

            <div className="map-nav-tabs">
              <button className={navTab === "hubs" ? "active" : ""} onClick={() => setNavTab("hubs")}>
                Хабы ({hubs.length})
              </button>
              <button className={navTab === "route" ? "active" : ""} onClick={() => setNavTab("route")}>
                Маршрут ({displayRoutePoints.filter((p) => !p.isHub).length})
              </button>
              {atlasCandidates.length > 0 && (
                <button className={navTab === "atlas" ? "active" : ""} onClick={() => setNavTab("atlas")}>
                  Atlas ({atlasCandidates.length})
                </button>
              )}
            </div>

            <input
              className="map-nav-search"
              type="text"
              placeholder="Поиск системы..."
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
            />

            {navTab !== "atlas" && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                {(["planned", "building", "done"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
                    style={{
                      padding: "3px 8px", borderRadius: 4, border: "1px solid",
                      borderColor: statusFilter === s ? STATUS_COLORS[s] : "#3a3d40",
                      background: statusFilter === s ? STATUS_COLORS[s] + "22" : "transparent",
                      color: statusFilter === s ? STATUS_COLORS[s] : "#9ca3af",
                      fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_COLORS[s], display: "inline-block" }} />
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            )}

            {navTab === "atlas" && atlasTypes.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                {atlasTypes.map((t) => (
                  <button
                    key={t}
                    onClick={() => setAtlasTypeFilter((prev) => (prev === t ? null : t))}
                    style={{
                      padding: "3px 8px", borderRadius: 4, border: "1px solid",
                      borderColor: atlasTypeFilter === t ? (ATLAS_TYPE_COLORS[t] || "#3a3d40") : "#3a3d40",
                      background: atlasTypeFilter === t ? (ATLAS_TYPE_COLORS[t] || "#9ca3af") + "22" : "transparent",
                      color: atlasTypeFilter === t ? (ATLAS_TYPE_COLORS[t] || "#9ca3af") : "#9ca3af",
                      fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: ATLAS_TYPE_COLORS[t] || "#9ca3af", display: "inline-block" }} />
                    {ATLAS_TYPE_LABELS[t] || t}
                  </button>
                ))}
              </div>
            )}

            <div className="map-nav-list">
              {navTab === "hubs"
                ? filteredHubs.map((hub) => (
                    <div key={hub.id} className={`map-nav-item ${selectedHub?.id === hub.id ? "selected" : ""}`} onClick={() => handleNavClickHub(hub)}>
                      <span className={`nav-dot status-${hub.status}`} />
                      <span className="nav-name">{hub.system_name}</span>
                      <span className="nav-meta">{hub.name || ""}</span>
                    </div>
                  ))
                : navTab === "route"
                ? filteredRoute.map((point) => (
                    <div key={point.id} className={`map-nav-item ${selectedRoutePoint?.id === point.id ? "selected" : ""}`} onClick={() => handleNavClickRoute(point)}>
                      <span className={`nav-dot status-${point.status}`} />
                      <span className="nav-name">{point.system_name}</span>
                      <span className="nav-meta">#{point.sort_order}</span>
                    </div>
                  ))
                : filteredAtlas.map((candidate) => (
                    <div key={candidate.id} className={`map-nav-item ${selectedAtlasCandidate?.id === candidate.id ? "selected" : ""}`} onClick={() => handleNavClickAtlas(candidate)}>
                      <span className="nav-dot" style={{ background: ATLAS_TYPE_COLORS[candidate.world_type] || "#9ca3af" }} />
                      <span className="nav-name">{candidate.system_name}</span>
                      <span className="nav-meta">{candidate.distance_from_ref?.toFixed(0)} ly</span>
                    </div>
                  ))}
            </div>
          </div>
        )}
      </div>

      {/* HUD */}
      <div className="galaxy-map-hud">
        <div className="hud-header">
          <div className="hud-title">КАРТА КОЛЬЦА</div>
          <div className="hud-subtitle">
            Хабов: <span className="hud-accent">{hubs.length}</span> · Точек маршрута:{" "}
            <span className="hud-accent">{displayRoutePoints.filter((p) => !p.isHub).length}</span>
            {atlasCandidates.length > 0 && (
              <> · Atlas: <span className="hud-accent">{atlasCandidates.length}</span></>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 8, pointerEvents: "auto" }}>
          <button onClick={handleResetView} style={{ background: "rgba(30,41,59,0.8)", border: "1px solid #3a3d40", color: "#9ca3af", padding: "4px 10px", borderRadius: 4, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            ⟲ Сброс вида
          </button>
        </div>

        {selectedHub && (
          <div className="hud-panel">
            <div className="hud-panel-name">{selectedHub.system_name}</div>
            <div className={`hud-panel-status status-${selectedHub.status}`}>{STATUS_LABELS[selectedHub.status]}</div>
            <div className="hud-panel-progress">
              <div className="hud-progress-bar"><div className="hud-progress-fill" style={{ width: `${selectedHub.progress}%` }} /></div>
              <div className="hud-progress-text">{selectedHub.progress}%</div>
            </div>
            <div className="hud-panel-coords">X:{selectedHub.x.toFixed(2)} · Y:{selectedHub.y.toFixed(2)} · Z:{selectedHub.z.toFixed(2)}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}>
              <div>До SAG A*: {Math.round(dist3(selectedHub, SAGA)).toLocaleString("ru")} св.лет</div>
              <div>До Sol: {Math.round(dist3(selectedHub, SOL)).toLocaleString("ru")} св.лет</div>
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 10, alignItems: "center" }}>
              <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(selectedHub.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> EDSM
              </a>
              <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedHub.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16"/><path d="M2 22V10l10-6 10 6v12"/><path d="M12 22V12"/></svg> RavenColonial
              </a>
            </div>
          </div>
        )}

        {selectedRoutePoint && (
          <div className="hud-panel">
            <div className="hud-panel-name">{selectedRoutePoint.system_name}</div>
            <div className={`hud-panel-status status-${selectedRoutePoint.status}`}>{STATUS_LABELS[selectedRoutePoint.status]}</div>
            <div className="hud-panel-progress">
              <div className="hud-progress-bar"><div className="hud-progress-fill" style={{ width: `${selectedRoutePoint.progress}%` }} /></div>
              <div className="hud-progress-text">{selectedRoutePoint.progress}%</div>
            </div>
            <div className="hud-panel-coords">X:{selectedRoutePoint.x.toFixed(2)} · Y:{selectedRoutePoint.y.toFixed(2)} · Z:{selectedRoutePoint.z.toFixed(2)}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}>
              <div>До SAG A*: {Math.round(dist3(selectedRoutePoint, SAGA)).toLocaleString("ru")} св.лет</div>
              <div>До Sol: {Math.round(dist3(selectedRoutePoint, SOL)).toLocaleString("ru")} св.лет</div>
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 10, alignItems: "center" }}>
              <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(selectedRoutePoint.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> EDSM
              </a>
              <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedRoutePoint.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16"/><path d="M2 22V10l10-6 10 6v12"/><path d="M12 22V12"/></svg> RavenColonial
              </a>
            </div>
          </div>
        )}

        {selectedAtlasCandidate && (
          <div className="hud-panel">
            <div className="hud-panel-name">{selectedAtlasCandidate.system_name}</div>
            <div style={{ color: ATLAS_TYPE_COLORS[selectedAtlasCandidate.world_type] || "#9ca3af", fontSize: 12, marginTop: 4 }}>
              {ATLAS_TYPE_LABELS[selectedAtlasCandidate.world_type] || selectedAtlasCandidate.world_type}
              {selectedAtlasCandidate.body_name && selectedAtlasCandidate.body_name !== selectedAtlasCandidate.system_name ? ` — ${selectedAtlasCandidate.body_name}` : ""}
            </div>
            <div className="hud-panel-coords" style={{ marginTop: 8 }}>X:{selectedAtlasCandidate.x.toFixed(2)} · Y:{selectedAtlasCandidate.y.toFixed(2)} · Z:{selectedAtlasCandidate.z.toFixed(2)}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}>
              <div>От референса: {selectedAtlasCandidate.distance_from_ref?.toFixed(1)} ly</div>
              {selectedAtlasCandidate.distance_to_arrival && <div>До прибытия: {selectedAtlasCandidate.distance_to_arrival.toFixed(0)} LS</div>}
              {selectedAtlasCandidate.estimated_value && <div>Стоимость скана: {selectedAtlasCandidate.estimated_value.toLocaleString("ru")} CR</div>}
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 10, alignItems: "center" }}>
              <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(selectedAtlasCandidate.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> EDSM
              </a>
              <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedAtlasCandidate.system_name)}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#9ca3af", fontSize: 12, textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e67e22"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#9ca3af"; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16"/><path d="M2 22V10l10-6 10 6v12"/><path d="M12 22V12"/></svg> RavenColonial
              </a>
            </div>
          </div>
        )}

        <div className="hud-legend">
          <div className="hud-legend-item"><span className="dot planned" /> Запланирован</div>
          <div className="hud-legend-item"><span className="dot building" /> Строительство</div>
          <div className="hud-legend-item"><span className="dot done" /> Завершён</div>
          <div className="hud-legend-item"><span className="dot landmark" /> Ключевая точка</div>
        </div>
      </div>

      <Canvas
        camera={{ position: [0, 35000, 0], fov: 45, near: 1, far: 200000 }}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        style={{ background: "#000000" }}
        frameloop="demand"
      >
        <Suspense fallback={<Loader />}>
          <GalaxyScene
            hubs={hubs}
            allRoutePoints={displayRoutePoints}
            squadronRoutePoints={squadronRoutePoints}
            atlasCandidates={atlasCandidates}
            onSelectHub={handleSelectHub}
            onSelectRoutePoint={handleSelectRoutePoint}
            onSelectAtlasCandidate={handleSelectAtlasCandidate}
            focusTarget={focusTarget}
            resetCamera={resetCamera}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
