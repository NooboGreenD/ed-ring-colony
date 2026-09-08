"use client";

import type { AtlasCandidate } from "@/types/atlas";

const TYPE_LABELS: Record<string, string> = {
  earth_like: 'Earth-like',
  water_world: 'Water',
  ammonia: 'Ammonia',
  terraformable: 'Terraformable',
  neutron_star: 'Neutron',
  black_hole: 'Black Hole',
  white_dwarf: 'White Dwarf',
  wolf_rayet: 'Wolf-Rayet',
  herbig_ae_be: 'Herbig',
  t_tauri: 'T Tauri',
  proto_star: 'Proto',
  carbon_star: 'Carbon',
  supergiant: 'Supergiant',
  giant: 'Giant',
  rocky_atmosphere: 'Rocky + Atm',
  rocky_bio: 'Rocky + Bio',
};

interface AtlasCandidateListProps {
  candidates: AtlasCandidate[];
  onSelect: (c: AtlasCandidate) => void;
  selectedId?: string | null;
}

export function AtlasCandidateList({ candidates, onSelect, selectedId }: AtlasCandidateListProps) {
  if (candidates.length === 0) {
    return <p className="empty">No candidates found. Run a search first.</p>;
  }

  return (
    <div className="atlas-candidate-list">
      {candidates.map(c => (
        <div
          key={c.id}
          onClick={() => onSelect(c)}
          className={`atlas-candidate-item${selectedId === c.id ? ' selected' : ''}`}
        >
          <div className="name">
            <span className="system-name">{c.system_name}</span>
            <span className="type-label">{TYPE_LABELS[c.world_type] || c.world_type}</span>
          </div>
          <div className="meta">
            {c.distance_from_ref?.toFixed(1)} ly from ref
            {c.distance_to_arrival ? ` · ${c.distance_to_arrival.toFixed(0)} LS` : ''}
            {c.estimated_value ? ` · ${c.estimated_value.toLocaleString()} CR` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
