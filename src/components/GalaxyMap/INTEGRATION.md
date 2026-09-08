// ============================================================
// INTEGRATION: Add these props to your existing GalaxyMap.tsx
// ============================================================

// 1. Import AtlasMarkers:
// import { AtlasMarkers } from "./AtlasMarkers";
// import type { AtlasCandidate } from "@/types/atlas";

// 2. Add to GalaxyMap props:
// interface GalaxyMapProps {
//   atlasCandidates?: AtlasCandidate[];
//   selectedAtlasId?: string | null;
//   onSelectAtlas?: (candidate: AtlasCandidate) => void;
// }

// 3. In GalaxyMap component, add state:
// const [selectedAtlasCandidate, setSelectedAtlasCandidate] = useState<AtlasCandidate | null>(null);

// 4. In the Canvas / GalaxyScene, add:
// <AtlasMarkers
//   candidates={atlasCandidates || []}
//   onSelect={(c) => { setSelectedAtlasCandidate(c); onSelectAtlas?.(c); }}
//   selectedId={selectedAtlasId}
// />

// 5. Add Atlas HUD panel (similar to selectedHub panel):
// {selectedAtlasCandidate && (
//   <div className="hud-panel">
//     <div className="hud-panel-name">{selectedAtlasCandidate.system_name}</div>
//     <div style={{ color: '#94a3b8', fontSize: 12 }}>
//       {selectedAtlasCandidate.world_type.replace('_', ' ')}
//       {selectedAtlasCandidate.body_name ? ` — ${selectedAtlasCandidate.body_name}` : ''}
//     </div>
//     <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
//       <div>Distance from ref: {selectedAtlasCandidate.distance_from_ref.toFixed(1)} ly</div>
//       {selectedAtlasCandidate.estimated_value && <div>Scan value: {selectedAtlasCandidate.estimated_value.toLocaleString()} CR</div>}
//     </div>
//     <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
//       <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(selectedAtlasCandidate.system_name)}`} target="_blank" rel="noreferrer" style={{ color: '#94a3b8', fontSize: 12 }}>EDSM</a>
//       <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedAtlasCandidate.system_name)}`} target="_blank" rel="noreferrer" style={{ color: '#94a3b8', fontSize: 12 }}>RavenColonial</a>
//     </div>
//   </div>
// )}

// 6. Add Atlas tab to nav panel:
// <button className={navTab === "atlas" ? "active" : ""} onClick={() => setNavTab("atlas")}>
//   Atlas ({atlasCandidates?.length || 0})
// </button>
