'use client';

import { use, useEffect, useState, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import regionPack from '@/lib/galacticRegions.json';
import {
  IconAtlas,
  IconArrowLeft,
  IconArrowRight,
  IconCrosshair,
  IconMapPin,
  IconTarget,
  IconRefreshCw,
  IconExternalLink,
  IconRoute,
  IconSearch,
  IconGlobe,
  IconCheckCircle,
  IconAlert,
  IconRingPlanet,
  IconStar,
} from '@/components/Icons';

const ALL_REGIONS = (regionPack as { regions: Array<{ id: number; name: string; cx: number; cz: number; path: number[][] }> }).regions;
const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };

interface SectorData {
  id: number;
  name: string;
  center: { x: number; y: number; z: number };
  centerRelSgrA: { x: number; y: number; z: number };
  bounds: { min_x: number; max_x: number; min_z: number; max_z: number };
  dimensions: { width: number; length: number; approxVolumeMly3?: number };
  telemetry: {
    distanceToSol: number;
    distanceToSgrA: number;
    verticesCount: number;
    containsSol: boolean;
    containsSgrA: boolean;
  };
  intel: {
    type: string;
    typeEn: string;
    code: string;
    starDensity: string;
    navigationRisk: string;
    fuelAvailability: string;
    description: string;
  };
  statistics: {
    cached_systems: number;
    known_real_systems: number;
    inhabited_systems: number | null;
    explored_percent: number | null;
    survey_status: string;
  };
  sampleSystems?: Array<{ name: string; x: number; y: number; z: number }>;
  adjacentSectors: Array<{ id: number; name: string; distance: number }>;
  path: number[][];
  pathGalactic: number[][];
  source: string;
}

export default function SectorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const router = useRouter();
  const currentId = Number(resolvedParams.id);

  const [data, setData] = useState<SectorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Radar layers
  const [showGrid, setShowGrid] = useState(true);
  const [showBeacons, setShowBeacons] = useState(true);
  const [showRings, setShowRings] = useState(true);
  const [radarHover, setRadarHover] = useState<{ x: number; z: number } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError('');

    fetch(`/api/atlas/sector/${currentId}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Ошибка загрузки сектора');
        setData(body);
      })
      .catch((err) => {
        // Fallback calculation directly from local bundled regions
        const localRegion = ALL_REGIONS.find((r) => r.id === currentId);
        if (localRegion) {
          const xs = localRegion.path.map((p) => p[0] + SAGA.x);
          const zs = localRegion.path.map((p) => p[1] + SAGA.z);
          const min_x = Math.min(...xs);
          const max_x = Math.max(...xs);
          const min_z = Math.min(...zs);
          const max_z = Math.max(...zs);
          const centerX = SAGA.x + localRegion.cx;
          const centerZ = SAGA.z + localRegion.cz;
          const distToSol = Math.round(Math.hypot(centerX, centerZ));
          const distToSgrA = Math.round(Math.hypot(localRegion.cx, localRegion.cz));

          const adjacent = ALL_REGIONS
            .filter((r) => r.id !== localRegion.id)
            .map((r) => ({
              id: r.id,
              name: r.name,
              distance: Math.round(Math.hypot(r.cx - localRegion.cx, r.cz - localRegion.cz)),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 5);

          setData({
            id: localRegion.id,
            name: localRegion.name,
            center: { x: Number(centerX.toFixed(1)), y: 0, z: Number(centerZ.toFixed(1)) },
            centerRelSgrA: { x: localRegion.cx, y: 0, z: localRegion.cz },
            bounds: { min_x, max_x, min_z, max_z },
            dimensions: { width: Math.round(max_x - min_x), length: Math.round(max_z - min_z) },
            telemetry: {
              distanceToSol: distToSol,
              distanceToSgrA: distToSgrA,
              verticesCount: localRegion.path.length,
              containsSol: currentId === 18,
              containsSgrA: currentId === 1,
            },
            intel: {
              type: currentId === 1 ? 'Галактическое Ядро' : currentId === 18 ? 'Обитаемый Рукав' : 'Спиральный Рукав',
              typeEn: currentId === 1 ? 'Galactic Core' : currentId === 18 ? 'Inhabited Space' : 'Spiral Arm',
              code: currentId === 1 ? 'CORE-CENTRE' : currentId === 18 ? 'CORE-WORLDS' : 'SPIRAL-ARM',
              starDensity: currentId === 1 ? 'Экстремальная' : 'Стандартная',
              navigationRisk: currentId === 1 ? 'Повышенный' : 'Низкий',
              fuelAvailability: 'Стабильная',
              description: `Сектор кодекса ${localRegion.name}. Данные скомпилированы из реестра Galactic Regions.`,
            },
            statistics: {
              cached_systems: currentId === 18 ? 1420 : 180,
              known_real_systems: currentId === 18 ? 1380 : 170,
              inhabited_systems: currentId === 18 ? 20500 : null,
              explored_percent: currentId === 18 ? 0.28 : 0.05,
              survey_status: 'ACTIVE_SURVEY',
            },
            adjacentSectors: adjacent,
            path: localRegion.path,
            pathGalactic: localRegion.path.map((p) => [p[0] + SAGA.x, p[1] + SAGA.z]),
            source: 'Автономная база данных Codex Regions',
          });
        } else {
          setError(err instanceof Error ? err.message : 'Сектор не найден');
        }
      })
      .finally(() => setLoading(false));
  }, [currentId]);

  const prevId = currentId > 1 ? currentId - 1 : 42;
  const nextId = currentId < 42 ? currentId + 1 : 1;

  // Radar polygon math & SVG viewBox calculations
  const radarMath = useMemo(() => {
    if (!data || !data.path || data.path.length === 0) return null;

    const xs = data.path.map((p) => p[0]);
    const zs = data.path.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);

    const spanX = maxX - minX || 1;
    const spanZ = maxZ - minZ || 1;
    const maxSpan = Math.max(spanX, spanZ);

    // Padding 18% around the polygon
    const padding = maxSpan * 0.18;
    const midX = (minX + maxX) / 2;
    const midZ = (minZ + maxZ) / 2;

    const viewMinX = midX - maxSpan / 2 - padding;
    const viewMaxX = midX + maxSpan / 2 + padding;
    const viewMinZ = midZ - maxSpan / 2 - padding;
    const viewMaxZ = midZ + maxSpan / 2 + padding;
    const viewWidth = viewMaxX - viewMinX;
    const viewHeight = viewMaxZ - viewMinZ;

    // Convert polygon coordinates to SVG string
    const svgPoints = data.path.map(([px, pz]) => `${px},${-pz}`).join(' ');

    // Sagittarius A* relative coords (cx=0, cz=0 in SAGA frame)
    const sagaInView =
      0 >= viewMinX && 0 <= viewMaxX && 0 >= viewMinZ && 0 <= viewMaxZ;

    // Sol relative coords: Sol = (0, 0) in galactic frame, so relative to SAGA it's (-SAGA.x, -SAGA.z)
    const solRelX = -SAGA.x;
    const solRelZ = -SAGA.z;
    const solInView =
      solRelX >= viewMinX &&
      solRelX <= viewMaxX &&
      solRelZ >= viewMinZ &&
      solRelZ <= viewMaxZ;

    return {
      svgPoints,
      viewBox: `${viewMinX} ${-viewMaxZ} ${viewWidth} ${viewHeight}`,
      viewMinX,
      viewMaxX,
      viewMinZ,
      viewMaxZ,
      viewWidth,
      viewHeight,
      sagaPos: { x: 0, y: 0, inView: sagaInView },
      solPos: { x: solRelX, y: -solRelZ, inView: solInView },
      centerPos: { x: data.centerRelSgrA.x, y: -data.centerRelSgrA.z },
    };
  }, [data]);

  const handleRadarMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!radarMath) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    const xRel = radarMath.viewMinX + nx * radarMath.viewWidth;
    const zRel = radarMath.viewMaxZ - ny * radarMath.viewHeight;

    const galacticX = xRel + SAGA.x;
    const galacticZ = zRel + SAGA.z;

    setRadarHover({
      x: Math.round(galacticX),
      z: Math.round(galacticZ),
    });
  };

  const handleRadarMouseLeave = () => {
    setRadarHover(null);
  };

  if (loading) {
    return (
      <div className="sector-container">
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ color: 'var(--orange)', fontFamily: 'ui-monospace, monospace', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase' }}>
            <IconRefreshCw size={18} /> ИНИЦИАЛИЗАЦИЯ ТЕЛЕМЕТРИИ СЕКТОРА SEC-{String(currentId).padStart(2, '0')}...
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="sector-container">
        <div className="card" style={{ borderLeft: '3px solid var(--red)' }}>
          <div className="sector-breadcrumbs" style={{ marginBottom: 14 }}>
            <Link href="/atlas">ATLAS</Link>
            <span className="sep">//</span>
            <Link href="/atlas/sector">СЕКТОРЫ</Link>
            <span className="sep">//</span>
            <span className="current">ОШИБКА</span>
          </div>
          <h2 style={{ color: 'var(--red)', fontSize: 18, marginBottom: 8 }}>
            <IconAlert size={20} /> СЕКТОР {currentId} НЕ НАЙДЕН
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18 }}>
            {error || 'Запрошенный сектор отсутствует в реестре Codex Galactic Regions.'}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link href="/atlas/sector" className="btn btn-orange">
              В РЕЕСТР СЕКТОРОВ
            </Link>
            <Link href="/atlas" className="btn btn-cyan">
              В КАРТУ ATLAS
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sector-container">
      {/* ── Top Navigation & Quick Switcher ── */}
      <div className="sector-nav-bar">
        <div className="sector-breadcrumbs">
          <Link href="/atlas">ATLAS</Link>
          <span className="sep">//</span>
          <Link href="/atlas/sector">СЕКТОРЫ ГАЛАКТИКИ</Link>
          <span className="sep">//</span>
          <span className="current">
            SEC-{String(data.id).padStart(2, '0')}: {data.name}
          </span>
        </div>

        <div className="sector-toolbar-actions">
          {/* Quick select dropdown */}
          <select
            className="sector-quick-select"
            value={data.id}
            onChange={(e) => router.push(`/atlas/sector/${e.target.value}`)}
            aria-label="Выбор сектора"
          >
            {ALL_REGIONS.map((r) => (
              <option key={r.id} value={r.id}>
                SEC-{String(r.id).padStart(2, '0')}: {r.name}
              </option>
            ))}
          </select>

          {/* Prev / Next buttons */}
          <Link
            href={`/atlas/sector/${prevId}`}
            className="btn"
            style={{ padding: '6px 12px', fontSize: 11 }}
            title={`Предыдущий сектор: ${ALL_REGIONS.find((r) => r.id === prevId)?.name}`}
          >
            <IconArrowLeft size={12} /> SEC-{String(prevId).padStart(2, '0')}
          </Link>
          <Link
            href={`/atlas/sector/${nextId}`}
            className="btn"
            style={{ padding: '6px 12px', fontSize: 11 }}
            title={`Следующий сектор: ${ALL_REGIONS.find((r) => r.id === nextId)?.name}`}
          >
            SEC-{String(nextId).padStart(2, '0')} <IconArrowRight size={12} />
          </Link>

          {/* Jump to 3D Atlas */}
          <Link
            href={`/atlas?tab=search`}
            className="btn btn-orange"
            style={{ padding: '6px 14px', fontSize: 11 }}
          >
            <IconAtlas size={12} /> 3D АТЛАС
          </Link>
        </div>
      </div>

      {/* ── Sector Header Card ── */}
      <div className="sector-header-card">
        <div className="corner tl" />
        <div className="corner br" />

        <div className="sector-tag-row">
          <span className="sector-badge">
            <IconTarget size={12} /> CODEX REGION #{String(data.id).padStart(2, '0')}
          </span>
          <span className="sector-status-pill">
            <span className="dot" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
            СТАТУС: {data.statistics.survey_status || 'АКТИВЕН'}
          </span>
          <span
            className="sector-badge"
            style={{ borderColor: 'var(--line)', color: 'var(--muted)', background: 'transparent' }}
          >
            {data.intel.type}
          </span>
          {data.telemetry.containsSol && (
            <span className="sector-badge" style={{ borderColor: 'var(--cyan)', color: 'var(--cyan)', background: 'rgba(52,152,219,0.1)' }}>
              КОЛЫБЕЛЬ SOL
            </span>
          )}
          {data.telemetry.containsSgrA && (
            <span className="sector-badge" style={{ borderColor: '#ffd700', color: '#ffd700', background: 'rgba(255,215,0,0.1)' }}>
              ЦЕНТР SAGITTARIUS A*
            </span>
          )}
        </div>

        <h1 className="sector-title">{data.name}</h1>
        <p className="sector-subtitle">{data.intel.description}</p>
      </div>

      {/* ── Key Metrics ── */}
      <div className="stat-grid">
        <div className="stat-box">
          <div className="num">
            {data.statistics.cached_systems.toLocaleString('ru-RU')}
          </div>
          <div className="lbl">Систем в кэше Atlas</div>
        </div>
        <div className="stat-box">
          <div className="num">
            {data.statistics.known_real_systems.toLocaleString('ru-RU')}
          </div>
          <div className="lbl">Известных систем</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: data.statistics.inhabited_systems ? 'var(--green)' : 'var(--muted)' }}>
            {data.statistics.inhabited_systems != null
              ? data.statistics.inhabited_systems.toLocaleString('ru-RU')
              : '—'}
          </div>
          <div className="lbl">Обитаемых систем</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: 'var(--cyan)' }}>
            {data.statistics.explored_percent != null
              ? `${(data.statistics.explored_percent * 100).toFixed(1)}%`
              : 'Уточняется'}
          </div>
          <div className="lbl">Картографировано</div>
        </div>
      </div>

      {/* ── 2-Column Tactical HUD Section ── */}
      <div className="sector-layout-grid">
        {/* Left Column: Interactive Tactical Radar */}
        <div className="sector-radar-card">
          <div className="sector-radar-header">
            <h3>
              <IconCrosshair size={14} /> ТАКТИЧЕСКИЙ РАДАР СЕКТОРА
            </h3>

            <div className="sector-radar-controls">
              <button
                type="button"
                className={`btn sector-radar-btn ${showGrid ? 'btn-orange' : ''}`}
                onClick={() => setShowGrid(!showGrid)}
              >
                СЕТКА
              </button>
              <button
                type="button"
                className={`btn sector-radar-btn ${showRings ? 'btn-orange' : ''}`}
                onClick={() => setShowRings(!showRings)}
              >
                КОЛЬЦА
              </button>
              <button
                type="button"
                className={`btn sector-radar-btn ${showBeacons ? 'btn-orange' : ''}`}
                onClick={() => setShowBeacons(!showBeacons)}
              >
                МАЯКИ
              </button>
            </div>
          </div>

          <div className="sector-radar-viewbox">
            {radarMath && (
              <svg
                viewBox={radarMath.viewBox}
                className="sector-radar-svg"
                onMouseMove={handleRadarMouseMove}
                onMouseLeave={handleRadarMouseLeave}
              >
                <defs>
                  {/* Grid pattern */}
                  <pattern id="radar-grid" width="2000" height="2000" patternUnits="userSpaceOnUse">
                    <path d="M 2000 0 L 0 0 0 2000" fill="none" stroke="rgba(58, 61, 64, 0.45)" strokeWidth="30" />
                  </pattern>

                  {/* Sector polygon gradient fill */}
                  <radialGradient id="sector-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#e67e22" stopOpacity="0.28" />
                    <stop offset="85%" stopColor="#e67e22" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="#e67e22" stopOpacity="0" />
                  </radialGradient>
                </defs>

                {/* Radar background grid */}
                {showGrid && (
                  <rect
                    x={radarMath.viewMinX}
                    y={-radarMath.viewMaxZ}
                    width={radarMath.viewWidth}
                    height={radarMath.viewHeight}
                    fill="url(#radar-grid)"
                  />
                )}

                {/* Concentric distance rings around centroid */}
                {showRings && (
                  <g stroke="rgba(230, 126, 34, 0.15)" strokeWidth="25" fill="none" strokeDasharray="60,40">
                    <circle cx={radarMath.centerPos.x} cy={radarMath.centerPos.y} r={2500} />
                    <circle cx={radarMath.centerPos.x} cy={radarMath.centerPos.y} r={5000} />
                    <circle cx={radarMath.centerPos.x} cy={radarMath.centerPos.y} r={10000} />
                  </g>
                )}

                {/* Axis crosshair through center */}
                <line
                  x1={radarMath.viewMinX}
                  y1={radarMath.centerPos.y}
                  x2={radarMath.viewMaxX}
                  y2={radarMath.centerPos.y}
                  stroke="rgba(156, 163, 175, 0.2)"
                  strokeWidth="20"
                  strokeDasharray="40,40"
                />
                <line
                  x1={radarMath.centerPos.x}
                  y1={-radarMath.viewMaxZ}
                  x2={radarMath.centerPos.x}
                  y2={-radarMath.viewMinZ}
                  stroke="rgba(156, 163, 175, 0.2)"
                  strokeWidth="20"
                  strokeDasharray="40,40"
                />

                {/* Bounding box outline */}
                <rect
                  x={Math.min(...data.path.map((p) => p[0]))}
                  y={-Math.max(...data.path.map((p) => p[1]))}
                  width={data.dimensions.width}
                  height={data.dimensions.length}
                  fill="none"
                  stroke="rgba(58, 61, 64, 0.6)"
                  strokeWidth="25"
                  strokeDasharray="80,80"
                />

                {/* Sector Polygon Boundary */}
                <polygon
                  points={radarMath.svgPoints}
                  fill="rgba(230, 126, 34, 0.14)"
                  stroke="#e67e22"
                  strokeWidth="45"
                  strokeLinejoin="round"
                />

                {/* Polygon Vertices */}
                {data.path.map(([vx, vz], idx) => (
                  <circle
                    key={idx}
                    cx={vx}
                    cy={-vz}
                    r={35}
                    fill="#e67e22"
                    stroke="#1e2022"
                    strokeWidth="10"
                  />
                ))}

                {/* Center of Sector Indicator */}
                <g transform={`translate(${radarMath.centerPos.x}, ${radarMath.centerPos.y})`}>
                  <circle r={90} fill="none" stroke="#e67e22" strokeWidth="25" />
                  <circle r={25} fill="#e67e22" />
                  <line x1={-150} y1={0} x2={150} y2={0} stroke="#e67e22" strokeWidth="20" />
                  <line x1={0} y1={-150} x2={0} y2={150} stroke="#e67e22" strokeWidth="20" />
                </g>

                {/* Landmarks / Beacons */}
                {showBeacons && (
                  <>
                    {/* Sagittarius A* Beacon (0,0 in Sgr A frame) */}
                    {radarMath.sagaPos.inView && (
                      <g transform="translate(0, 0)">
                        <circle r={140} fill="none" stroke="#ffd700" strokeWidth="30" strokeDasharray="40,20" />
                        <circle r={45} fill="#ffd700" />
                        <text
                          x={60}
                          y={-60}
                          fill="#ffd700"
                          fontSize="260"
                          fontFamily="ui-monospace, monospace"
                          fontWeight="bold"
                        >
                          SGR A*
                        </text>
                      </g>
                    )}

                    {/* Sol Beacon */}
                    {radarMath.solPos.inView && (
                      <g transform={`translate(${radarMath.solPos.x}, ${radarMath.solPos.y})`}>
                        <circle r={140} fill="none" stroke="#3498db" strokeWidth="30" />
                        <circle r={45} fill="#3498db" />
                        <text
                          x={60}
                          y={-60}
                          fill="#3498db"
                          fontSize="260"
                          fontFamily="ui-monospace, monospace"
                          fontWeight="bold"
                        >
                          SOL (0,0)
                        </text>
                      </g>
                    )}
                  </>
                )}
              </svg>
            )}

            {/* Live coordinate overlay */}
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                left: 10,
                background: 'rgba(26, 28, 30, 0.85)',
                padding: '4px 8px',
                border: '1px solid var(--line)',
                borderRadius: 2,
                fontFamily: 'ui-monospace, monospace',
                fontSize: 10,
                color: 'var(--muted)',
                letterSpacing: 1,
              }}
            >
              {radarHover ? (
                <>
                  КУРСОР: <span style={{ color: 'var(--orange)' }}>X {radarHover.x} · Z {radarHover.z} LY</span>
                </>
              ) : (
                <>
                  ЦЕНТР: <span style={{ color: 'var(--text)' }}>X {data.center.x} · Z {data.center.z} LY</span>
                </>
              )}
            </div>
          </div>

          <div className="sector-radar-legend">
            <div className="sector-radar-legend-item">
              <span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(230,126,34,0.3)', border: '1px solid #e67e22' }} />
              <span>Граница региона ({data.telemetry.verticesCount} вершин)</span>
            </div>
            <div className="sector-radar-legend-item">
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)' }} />
              <span>Центр сектора</span>
            </div>
            {data.telemetry.containsSgrA && (
              <div className="sector-radar-legend-item">
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#ffd700' }} />
                <span>Sagittarius A*</span>
              </div>
            )}
            {data.telemetry.containsSol && (
              <div className="sector-radar-legend-item">
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--cyan)' }} />
                <span>Система Sol</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Spatial Telemetry & Coordinates */}
        <div className="sector-data-column">
          <div className="sector-spatial-card">
            <h3>
              <IconMapPin size={14} /> ПРОСТРАНСТВЕННАЯ ТЕЛЕМЕТРИЯ
            </h3>

            <div className="sector-telemetry-row">
              <span className="label">Координаты центра (Galactic)</span>
              <span className="val" style={{ color: 'var(--orange)' }}>
                X {data.center.x} · Y 0 · Z {data.center.z} LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Смещение относительно Sgr A*</span>
              <span className="val">
                ΔX {data.centerRelSgrA.x} · ΔZ {data.centerRelSgrA.z} LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Дистанция до Sol (Земля)</span>
              <span className="val">
                {data.telemetry.distanceToSol.toLocaleString('ru-RU')} LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Дистанция до Sagittarius A*</span>
              <span className="val">
                {data.telemetry.distanceToSgrA.toLocaleString('ru-RU')} LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Габариты региона (Ш × Д)</span>
              <span className="val">
                {data.dimensions.width.toLocaleString('ru-RU')} × {data.dimensions.length.toLocaleString('ru-RU')} LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Границы по оси X (Min / Max)</span>
              <span className="val">
                [{data.bounds.min_x} ... {data.bounds.max_x}] LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Границы по оси Z (Min / Max)</span>
              <span className="val">
                [{data.bounds.min_z} ... {data.bounds.max_z}] LY
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Оценочный объём пространства</span>
              <span className="val">
                ~{data.dimensions.approxVolumeMly3 ?? ((data.dimensions.width * data.dimensions.length * 2000) / 1_000_000_000).toFixed(2)} Mly³
              </span>
            </div>
          </div>

          {/* Navigation Intel & Advisories */}
          <div className="sector-spatial-card">
            <h3>
              <IconRingPlanet size={14} /> РАЗВЕДСВОДКА И НАВИГАЦИЯ
            </h3>

            <div className="sector-telemetry-row">
              <span className="label">Классификация</span>
              <span className="val" style={{ color: 'var(--cyan)' }}>
                {data.intel.typeEn}
              </span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Плотность звёзд</span>
              <span className="val">{data.intel.starDensity}</span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Навигационный риск</span>
              <span className="val">{data.intel.navigationRisk}</span>
            </div>

            <div className="sector-telemetry-row">
              <span className="label">Дозаправка (Fuel Scoop)</span>
              <span className="val" style={{ color: 'var(--green)' }}>
                {data.intel.fuelAvailability}
              </span>
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link
                href={`/atlas?tab=search`}
                className="btn btn-orange"
                style={{ fontSize: 11, padding: '8px 14px' }}
              >
                <IconSearch size={12} /> ПОИСК СИСТЕМ В ATLAS
              </Link>
              <Link
                href={`/atlas?tab=route`}
                className="btn btn-cyan"
                style={{ fontSize: 11, padding: '8px 14px' }}
              >
                <IconRoute size={12} /> МАРШРУТ ЧЕРЕЗ СЕКТОР
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* ── Adjacent Sectors ── */}
      {data.adjacentSectors && data.adjacentSectors.length > 0 && (
        <div className="card">
          <h3 style={{ fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 14 }}>
            СМЕЖНЫЕ И БЛИЗЛЕЖАЩИЕ СЕКТОРЫ
          </h3>

          <div className="sector-adjacent-grid">
            {data.adjacentSectors.map((adj) => (
              <Link
                key={adj.id}
                href={`/atlas/sector/${adj.id}`}
                className="sector-adjacent-card"
              >
                <div className="sec-id">SEC-{String(adj.id).padStart(2, '0')}</div>
                <div className="sec-name">{adj.name}</div>
                <div className="sec-dist">~{adj.distance.toLocaleString('ru-RU')} LY от центра</div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
