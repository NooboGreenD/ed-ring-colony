'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import regionPack from '@/lib/galacticRegions.json';
import {
  IconAtlas,
  IconSearch,
  IconCrosshair,
  IconTarget,
  IconArrowRight,
  IconMapPin,
  IconGlobe,
  IconStar,
} from '@/components/Icons';

const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };

interface RawRegion {
  id: number;
  name: string;
  cx: number;
  cz: number;
  path: number[][];
}

const RAW_REGIONS: RawRegion[] = (regionPack as any).regions;

export default function GalacticSectorsIndexPage() {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<'all' | 'sol' | 'core' | 'arms' | 'rim'>('all');
  const [sortBy, setSortBy] = useState<'id' | 'name' | 'distSol' | 'distSgrA'>('id');

  // Process all 42 regions with geometry and distances
  const sectors = useMemo(() => {
    return RAW_REGIONS.map((region) => {
      const xsGalactic = region.path.map((p) => p[0] + SAGA.x);
      const zsGalactic = region.path.map((p) => p[1] + SAGA.z);
      const min_x = Math.min(...xsGalactic);
      const max_x = Math.max(...xsGalactic);
      const min_z = Math.min(...zsGalactic);
      const max_z = Math.max(...zsGalactic);

      const centerX = SAGA.x + region.cx;
      const centerZ = SAGA.z + region.cz;
      const distToSol = Math.round(Math.hypot(centerX, centerZ));
      const distToSgrA = Math.round(Math.hypot(region.cx, region.cz));

      let category: 'sol' | 'core' | 'arms' | 'rim' = 'arms';
      if (region.id === 1 || distToSgrA < 8000) {
        category = 'core';
      } else if (region.id === 18 || distToSol < 15000) {
        category = 'sol';
      } else if (distToSol > 45000) {
        category = 'rim';
      }

      // Compute mini SVG polygon string & local viewBox for thumbnail
      const xsRel = region.path.map((p) => p[0]);
      const zsRel = region.path.map((p) => p[1]);
      const minXRel = Math.min(...xsRel);
      const maxXRel = Math.max(...xsRel);
      const minZRel = Math.min(...zsRel);
      const maxZRel = Math.max(...zsRel);
      const span = Math.max(maxXRel - minXRel, maxZRel - minZRel) || 1;
      const pad = span * 0.15;
      const midX = (minXRel + maxXRel) / 2;
      const midZ = (minZRel + maxZRel) / 2;
      const vbMinX = midX - span / 2 - pad;
      const vbMaxZ = midZ + span / 2 + pad;
      const vbDim = span + pad * 2;

      const svgPoints = region.path.map(([px, pz]) => `${px},${-pz}`).join(' ');

      return {
        id: region.id,
        name: region.name,
        centerX: Math.round(centerX),
        centerZ: Math.round(centerZ),
        distToSol,
        distToSgrA,
        width: Math.round(max_x - min_x),
        length: Math.round(max_z - min_z),
        verticesCount: region.path.length,
        category,
        isSolSector: region.id === 18,
        isSgrASector: region.id === 1,
        svgPoints,
        viewBox: `${vbMinX} ${-vbMaxZ} ${vbDim} ${vbDim}`,
        centerRelSgrA: { x: region.cx, y: -region.cz },
      };
    });
  }, []);

  // Filtered & Sorted sectors
  const filteredSectors = useMemo(() => {
    let result = sectors.filter((s) => {
      // Category filter
      if (filterCategory !== 'all') {
        if (filterCategory === 'sol' && s.category !== 'sol') return false;
        if (filterCategory === 'core' && s.category !== 'core') return false;
        if (filterCategory === 'rim' && s.category !== 'rim') return false;
        if (filterCategory === 'arms' && s.category !== 'arms') return false;
      }
      // Text search
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchName = s.name.toLowerCase().includes(q);
        const matchId = String(s.id) === q || `sec-${s.id}`.includes(q) || `sec-${String(s.id).padStart(2, '0')}`.includes(q);
        return matchName || matchId;
      }
      return true;
    });

    result.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'distSol') return a.distToSol - b.distToSol;
      if (sortBy === 'distSgrA') return a.distToSgrA - b.distToSgrA;
      return a.id - b.id;
    });

    return result;
  }, [sectors, search, filterCategory, sortBy]);

  return (
    <div className="sector-container">
      {/* ── Breadcrumb Bar ── */}
      <div className="sector-nav-bar">
        <div className="sector-breadcrumbs">
          <Link href="/atlas">ATLAS</Link>
          <span className="sep">//</span>
          <span className="current">РЕЕСТР ГАЛАКТИЧЕСКИХ СЕКТОРОВ</span>
        </div>

        <div className="sector-toolbar-actions">
          <Link href="/atlas" className="btn btn-orange" style={{ padding: '6px 14px', fontSize: 11 }}>
            <IconAtlas size={12} /> 3D КАРТА ATLAS
          </Link>
        </div>
      </div>

      {/* ── Header ── */}
      <div className="sector-header-card">
        <div className="corner tl" />
        <div className="corner br" />

        <div className="sector-tag-row">
          <span className="sector-badge">
            <IconTarget size={12} /> CODEX REGIONS // 42 СЕКТОРА
          </span>
          <span className="sector-status-pill">
            <span className="dot" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
            КАРТОГРАФИРОВАНИЕ АКТИВНО
          </span>
        </div>

        <h1 className="sector-title">ГАЛАКТИЧЕСКИЕ СЕКТОРЫ</h1>
        <p className="sector-subtitle">
          Официальный реестр 42 секторов Млечного Пути из базы Codex Elite Dangerous.
          Каждый сектор содержит полигональные границы квантованной сетки, пространственные координаты,
          удаление от центра ядра (Sagittarius A*) и Солнечной системы (Sol).
        </p>
      </div>

      {/* ── Key Summary Stats ── */}
      <div className="stat-grid">
        <div className="stat-box">
          <div className="num">42</div>
          <div className="lbl">Секторов в реестре</div>
        </div>
        <div className="stat-box">
          <div className="num">~100 000</div>
          <div className="lbl">Диаметр охвата (св. л.)</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: 'var(--cyan)' }}>SEC-18</div>
          <div className="lbl">Сектор Sol (Orion Spur)</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: '#ffd700' }}>SEC-01</div>
          <div className="lbl">Галактический Центр</div>
        </div>
      </div>

      {/* ── Filter & Search Controls ── */}
      <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Search box */}
          <div style={{ position: 'relative', minWidth: 260, flex: '1 1 300px' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или номеру (напр. Orion, 18, Core)..."
              style={{ width: '100%', margin: 0, paddingLeft: 36 }}
            />
            <span style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted)' }}>
              <IconSearch size={14} />
            </span>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--muted)',
                  padding: '2px 6px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Sort selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
              СОРТИРОВКА:
            </span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="inline-select"
              style={{ margin: 0, padding: '6px 10px', fontSize: 12 }}
            >
              <option value="id">По номеру ID (1..42)</option>
              <option value="name">По алфавиту (A..Z)</option>
              <option value="distSol">Ближе к Sol</option>
              <option value="distSgrA">Ближе к Sagittarius A*</option>
            </select>
          </div>
        </div>

        {/* Filter pills */}
        <div className="filter-pills" style={{ marginTop: 14, marginBottom: 0 }}>
          <button
            type="button"
            className={`filter-pill ${filterCategory === 'all' ? 'active' : ''}`}
            onClick={() => setFilterCategory('all')}
          >
            Все секторы <span className="count">42</span>
          </button>
          <button
            type="button"
            className={`filter-pill ${filterCategory === 'sol' ? 'active' : ''}`}
            onClick={() => setFilterCategory('sol')}
          >
            Около Sol (&lt; 15k LY)
          </button>
          <button
            type="button"
            className={`filter-pill ${filterCategory === 'core' ? 'active' : ''}`}
            onClick={() => setFilterCategory('core')}
          >
            Галактическое Ядро
          </button>
          <button
            type="button"
            className={`filter-pill ${filterCategory === 'arms' ? 'active' : ''}`}
            onClick={() => setFilterCategory('arms')}
          >
            Спиральные рукава
          </button>
          <button
            type="button"
            className={`filter-pill ${filterCategory === 'rim' ? 'active' : ''}`}
            onClick={() => setFilterCategory('rim')}
          >
            Внешний Рубеж (&gt; 45k LY)
          </button>
        </div>
      </div>

      {/* ── Results Count ── */}
      <div style={{ marginBottom: 14, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
        НАЙДЕНО СЕКТОРОВ: <span style={{ color: 'var(--orange)', fontWeight: 'bold' }}>{filteredSectors.length}</span> ИЗ 42
      </div>

      {/* ── Sectors Grid ── */}
      <div className="sector-catalog-grid">
        {filteredSectors.map((sector) => (
          <Link
            key={sector.id}
            href={`/atlas/sector/${sector.id}`}
            className="sector-catalog-card"
          >
            <div className="sector-catalog-card-header">
              <span className="sector-badge">
                SEC-{String(sector.id).padStart(2, '0')}
              </span>
              {sector.isSolSector && (
                <span className="badge" style={{ background: 'var(--cyan)', color: '#1e2022', fontSize: 10 }}>
                  SOL
                </span>
              )}
              {sector.isSgrASector && (
                <span className="badge" style={{ background: '#ffd700', color: '#1e2022', fontSize: 10 }}>
                  SGR A*
                </span>
              )}
            </div>

            <div className="sector-catalog-title">{sector.name}</div>

            {/* Mini Radar Thumbnail */}
            <div className="sector-catalog-thumb">
              <svg viewBox={sector.viewBox} style={{ width: '100%', height: '100%' }}>
                {/* Radar Grid */}
                <circle cx={sector.centerRelSgrA.x} cy={sector.centerRelSgrA.y} r={1800} fill="none" stroke="rgba(58, 61, 64, 0.4)" strokeWidth="30" strokeDasharray="40,40" />
                {/* Sector polygon */}
                <polygon
                  points={sector.svgPoints}
                  fill="rgba(230, 126, 34, 0.16)"
                  stroke="#e67e22"
                  strokeWidth="40"
                  strokeLinejoin="round"
                />
                {/* Centroid dot */}
                <circle cx={sector.centerRelSgrA.x} cy={sector.centerRelSgrA.y} r={70} fill="#e67e22" />
              </svg>
            </div>

            {/* Telemetry metadata */}
            <div className="sector-catalog-meta">
              <div className="sector-catalog-meta-row">
                <span>Центр (X / Z):</span>
                <span>{sector.centerX} / {sector.centerZ} LY</span>
              </div>
              <div className="sector-catalog-meta-row">
                <span>Дистанция до Sol:</span>
                <span style={{ color: 'var(--cyan)' }}>{sector.distToSol.toLocaleString('ru-RU')} LY</span>
              </div>
              <div className="sector-catalog-meta-row">
                <span>Дистанция до Sgr A*:</span>
                <span style={{ color: 'var(--orange)' }}>{sector.distToSgrA.toLocaleString('ru-RU')} LY</span>
              </div>
              <div className="sector-catalog-meta-row">
                <span>Габариты региона:</span>
                <span>{sector.width.toLocaleString('ru-RU')} × {sector.length.toLocaleString('ru-RU')} LY</span>
              </div>
            </div>

            <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--orange)', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1 }}>
              <span>ОБЗОР СЕКТОРА</span>
              <IconArrowRight size={12} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
