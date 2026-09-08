"use client";

import { useState } from "react";
import type { WorldType } from "@/types/atlas";

const WORLD_TYPE_OPTIONS: { value: WorldType; label: string; color: string }[] = [
  { value: 'earth_like', label: 'Earth-like', color: '#4caf50' },
  { value: 'water_world', label: 'Water World', color: '#2196f3' },
  { value: 'ammonia', label: 'Ammonia World', color: '#ff9800' },
  { value: 'terraformable', label: 'Terraformable', color: '#8bc34a' },
  { value: 'neutron_star', label: 'Neutron Star', color: '#00bcd4' },
  { value: 'black_hole', label: 'Black Hole', color: '#9c27b0' },
  { value: 'white_dwarf', label: 'White Dwarf', color: '#e0e0e0' },
  { value: 'wolf_rayet', label: 'Wolf-Rayet', color: '#ff5722' },
];

const ROCKY_OPTIONS: { value: WorldType; label: string; color: string }[] = [
  { value: 'rocky_atmosphere', label: 'Rocky + Atmosphere', color: '#a1887f' },
  { value: 'rocky_bio', label: 'Rocky + Biology', color: '#66bb6a' },
];

interface AtlasSearchPanelProps {
  onSearch: (params: {
    reference_system: string;
    cube_size_ly: number;
    world_types: WorldType[];
    require_landable?: boolean;
    min_estimated_value?: number;
    max_distance_to_arrival?: number;
  }) => void;
  loading?: boolean;
}

export function AtlasSearchPanel({ onSearch, loading }: AtlasSearchPanelProps) {
  const [refSystem, setRefSystem] = useState('Sol');
  const [cubeSize, setCubeSize] = useState(500);
  const [selectedTypes, setSelectedTypes] = useState<WorldType[]>(['earth_like']);
  const [requireLandable, setRequireLandable] = useState(false);
  const [minValue, setMinValue] = useState(0);
  const [maxDist, setMaxDist] = useState(0);

  const toggleType = (t: WorldType) => {
    setSelectedTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  const handleSubmit = () => {
    const ref = refSystem.trim();
    if (!ref) return;
    onSearch({
      reference_system: ref,
      cube_size_ly: cubeSize,
      world_types: selectedTypes,
      require_landable: requireLandable || undefined,
      min_estimated_value: minValue > 0 ? minValue : undefined,
      max_distance_to_arrival: maxDist > 0 ? maxDist : undefined,
    });
  };

  return (
    <div className="atlas-search-panel">
      <h3>Atlas Search</h3>

      <div className="atlas-search-field">
        <label>Reference System</label>
        <input
          type="text"
          placeholder="e.g. Sol, Colonia, Sagittarius A*..."
          value={refSystem}
          onChange={e => setRefSystem(e.target.value)}
        />
      </div>

      <div className="atlas-search-field">
        <label>Cube Size: {cubeSize} ly</label>
        <input type="range" min={100} max={5000} step={100} value={cubeSize} onChange={e => setCubeSize(Number(e.target.value))} />
      </div>

      <div className="atlas-search-field">
        <label>World Types</label>
        <div className="atlas-type-grid">
          {WORLD_TYPE_OPTIONS.map(t => (
            <button
              key={t.value}
              onClick={() => toggleType(t.value)}
              className={`atlas-type-btn${selectedTypes.includes(t.value) ? ' active' : ''}`}
              style={selectedTypes.includes(t.value) ? { borderColor: t.color, color: t.color, background: t.color + '22' } : {}}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="atlas-search-field">
        <label>Rocky Planets</label>
        <div className="atlas-type-grid">
          {ROCKY_OPTIONS.map(t => (
            <button
              key={t.value}
              onClick={() => toggleType(t.value)}
              className={`atlas-type-btn${selectedTypes.includes(t.value) ? ' active' : ''}`}
              style={selectedTypes.includes(t.value) ? { borderColor: t.color, color: t.color, background: t.color + '22' } : {}}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="atlas-search-field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={requireLandable} onChange={e => setRequireLandable(e.target.checked)} />
          Require Landable
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div className="atlas-search-field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Min Scan Value</label>
          <input type="number" value={minValue || ''} onChange={e => setMinValue(Number(e.target.value))} placeholder="0" />
        </div>
        <div className="atlas-search-field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Max Dist to Arrival (LS)</label>
          <input type="number" value={maxDist || ''} onChange={e => setMaxDist(Number(e.target.value))} placeholder="&#8734;" />
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading || selectedTypes.length === 0 || !refSystem.trim()}
        className="atlas-scan-btn"
      >
        {loading ? 'Scanning...' : 'Scan Sector'}
      </button>
    </div>
  );
}
