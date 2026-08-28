"use client";

import { useState } from 'react';
import type { ProjectSystem, ProjectRoutePoint } from '@/types/project';

interface Props {
  projectId: number;
  systems: ProjectSystem[];
  route: ProjectRoutePoint[];
  onUpdate: () => void;
}

export default function ProjectRoutePlanner({ projectId, systems, route, onUpdate }: Props) {
  const [optimizing, setOptimizing] = useState(false);
  const [startSystem, setStartSystem] = useState('');

  const optimizeRoute = async () => {
    setOptimizing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_system: startSystem || undefined }),
      });
      if (!res.ok) throw new Error('Optimization failed');
      onUpdate();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setOptimizing(false);
    }
  };

  const totalDistance = route.length > 0 
    ? route[route.length - 1].cumulative_distance 
    : 0;

  return (
    <div style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, color: '#eeeeee', fontSize: 16 }}>🗺️ Маршрут строительства</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={startSystem}
            onChange={(e) => setStartSystem(e.target.value)}
            style={{
              background: '#323538',
              border: '1px solid #3a3d40',
              color: '#eeeeee',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <option value="">Авто (ближайший)</option>
            {systems.map(s => (
              <option key={s.id} value={s.system_name}>{s.system_name}</option>
            ))}
          </select>
          <button
            onClick={optimizeRoute}
            disabled={optimizing}
            style={{
              padding: '6px 14px',
              background: optimizing ? '#3a3d40' : 'rgba(139,92,246,0.15)',
              border: '1px solid rgba(139,92,246,0.4)',
              color: '#a78bfa',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: optimizing ? 'not-allowed' : 'pointer',
            }}
          >
            {optimizing ? '⚡ Оптимизация...' : '⚡ Оптимизировать маршрут'}
          </button>
        </div>
      </div>

      {route.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#9ca3af' }}>
          Общая дистанция: <strong style={{ color: '#eeeeee' }}>{totalDistance.toFixed(1)} св. лет</strong> · 
          Переходов: <strong style={{ color: '#eeeeee' }}>{route.length}</strong>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {route.map((point, idx) => (
          <div key={point.system_name} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: '#323538',
            borderRadius: 8,
            fontSize: 13,
          }}>
            <div style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: idx === 0 ? '#22c55e' : idx === route.length - 1 ? '#e74c3c' : '#3b82f6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
            }}>
              {idx + 1}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#eeeeee', fontWeight: 600 }}>{point.system_name}</div>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>
                {point.distance_from_prev > 0 && `+${point.distance_from_prev.toFixed(1)} св. лет · `}
                Всего: {point.cumulative_distance.toFixed(1)} св. лет
              </div>
            </div>
            <div style={{ color: '#9ca3af', fontSize: 11, textAlign: 'right' }}>
              {point.x.toFixed(1)} / {point.y.toFixed(1)} / {point.z.toFixed(1)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
