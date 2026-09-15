'use client';

import React, { useEffect, useRef, useState } from 'react';
import { IconGlobe, IconMaximize, IconMinimize, IconRefreshCw } from '@/components/Icons';

declare global {
  interface Window {
    Plotly?: any;
  }
}

interface ProjectData {
  buildId: string;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  bodyName: string | null;
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number;
  resources?: any[];
}

interface SystemPlotlyMapProps {
  systemName: string;
  projects?: ProjectData[];
  initialBodies?: any[];
}

// Палитра классов планет Elite Dangerous
const BODY_CLASS_COLORS: Record<string, string> = {
  earthlike: '#2ecc71',
  water: '#3498db',
  ammonia: '#b39ddb',
  metal: '#e67e22',
  rich: '#f1c40f',
  rocky: '#a08c7d',
  icy: '#9fd8ef',
  gas: '#ff9f43',
  helium: '#48dbfb',
};

const STAR_SPECTRAL_COLORS: Record<string, string> = {
  O: '#9bb0ff',
  B: '#bbccff',
  A: '#f8f9fa',
  F: '#fff4e8',
  G: '#ffd166',
  K: '#ff9e42',
  M: '#ff5533',
  N: '#00d4ff',
  Neutron: '#00d4ff',
  H: '#4a0e4e',
};

function getStarColor(subType?: string | null): string {
  const clean = (subType || '').trim();
  for (const [k, c] of Object.entries(STAR_SPECTRAL_COLORS)) {
    if (clean.toUpperCase().startsWith(k.toUpperCase())) return c;
  }
  return '#ffd166';
}

function getBodyColor(subType?: string | null, bodyType?: string | null): string {
  const s = ((subType || '') + ' ' + (bodyType || '')).toLowerCase();
  for (const [k, c] of Object.entries(BODY_CLASS_COLORS)) {
    if (s.includes(k)) return c;
  }
  return '#8d99ae';
}

export default function SystemPlotlyMap({
  systemName,
  projects = [],
  initialBodies,
}: SystemPlotlyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bodies, setBodies] = useState<any[]>(initialBodies || []);
  const [loading, setLoading] = useState<boolean>(!initialBodies || initialBodies.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  // Загрузка библиотеки Plotly.js через CDN
  useEffect(() => {
    if (window.Plotly) {
      setScriptLoaded(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
    script.async = true;
    script.onload = () => setScriptLoaded(true);
    script.onerror = () => setError('Не удалось загрузить 3D-движок Plotly');
    document.head.appendChild(script);
  }, []);

  // Загрузка списка тел системы, если не переданы явно
  useEffect(() => {
    if (initialBodies && initialBodies.length > 0) {
      setBodies(initialBodies);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetch(`/api/atlas/system-bodies?system=${encodeURIComponent(systemName)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.bodies)) {
          setBodies(data.bodies);
        }
      })
      .catch((err) => {
        console.warn('[SystemPlotlyMap] Failed fetching bodies:', err);
      })
      .finally(() => setLoading(false));
  }, [systemName, initialBodies]);

  // Построение 3D карты через Plotly
  useEffect(() => {
    if (!scriptLoaded || !window.Plotly || !containerRef.current) return;

    const Plotly = window.Plotly;
    const isStar = (b: any) => {
      const t = ((b.body_type || b.type || '') + ' ' + (b.sub_type || b.subType || '')).toLowerCase();
      return t.includes('star') || t.includes('звезд') || (b.distance_ls === 0 && !t.includes('planet'));
    };

    const isMoon = (b: any) => {
      return (Array.isArray(b.parents) && b.parents.length > 0 && b.parents.some((p: any) => p && ('Planet' in p || 'planet' in p)))
        || (b.body_type || '').toLowerCase() === 'moon';
    };

    const stars = bodies.filter((b) => isStar(b));
    const primaryStar = stars[0] || null;
    const otherStars = stars.slice(1);
    const planets = bodies.filter((b) => !isStar(b) && !isMoon(b));
    const moons = bodies.filter((b) => isMoon(b));

    // Сортировка планет по расстоянию
    planets.sort((a, b) => (a.distance_ls || 0) - (b.distance_ls || 0));

    // Логарифмическое масштабирование орбит
    const rMin = 24.0;
    const rMax = 230.0;
    const allOrbiters = [...planets, ...otherStars];
    const orbitRadii: Record<string, number> = {};

    if (allOrbiters.length === 1) {
      orbitRadii[allOrbiters[0].body_name] = 60.0;
    } else if (allOrbiters.length > 1) {
      const dists = allOrbiters.map((b) => Math.max(0.1, b.distance_ls || 0));
      const logMin = Math.log10(Math.min(...dists));
      const logMax = Math.log10(Math.max(...dists));
      const logSpan = Math.max(1e-4, logMax - logMin);
      const minStep = Math.max(12.0, (rMax - rMin) / (allOrbiters.length + 1));
      let curR = rMin;

      allOrbiters.forEach((b) => {
        const d = Math.max(0.1, b.distance_ls || 0);
        const logFrac = (Math.log10(d) - logMin) / logSpan;
        const targetR = Math.max(curR, rMin + logFrac * (rMax - rMin));
        orbitRadii[b.body_name] = targetR;
        curR = targetR + minStep;
      });
    }

    const positions: Record<string, [number, number, number]> = {};
    const goldenAngle = 2.399963229728653;

    if (primaryStar) {
      positions[primaryStar.body_name] = [0, 0, 0];
    } else {
      positions['__center__'] = [0, 0, 0];
    }

    // Вычисление 3D координат планет и орбит
    const orbXs: (number | null)[] = [];
    const orbYs: (number | null)[] = [];
    const orbZs: (number | null)[] = [];

    allOrbiters.forEach((b, idx) => {
      const a = orbitRadii[b.body_name] || (40 + idx * 18);
      const incDeg = ((-1) ** idx) * (3.0 + ((idx * 5) % 8));
      const incRad = (incDeg * Math.PI) / 180.0;
      const theta = (idx * goldenAngle) % (2 * Math.PI);

      // Орбитальное кольцо (72 точки)
      const steps = 72;
      for (let s = 0; s <= steps; s++) {
        const phi = (2 * Math.PI * s) / steps;
        const xp = a * Math.cos(phi);
        const yp = a * Math.sin(phi);
        orbXs.push(xp);
        orbYs.push(yp * Math.cos(incRad));
        orbZs.push(yp * Math.sin(incRad));
      }
      orbXs.push(null);
      orbYs.push(null);
      orbZs.push(null);

      // Положение планеты
      const px = a * Math.cos(theta);
      const py = a * Math.sin(theta) * Math.cos(incRad);
      const pz = a * Math.sin(theta) * Math.sin(incRad);
      positions[b.body_name] = [px, py, pz];
    });

    // Луны вокруг планет
    const mOrbXs: (number | null)[] = [];
    const mOrbYs: (number | null)[] = [];
    const mOrbZs: (number | null)[] = [];

    moons.forEach((m, mIdx) => {
      // Ищем родительскую планету по имени
      let pName = '';
      if (Array.isArray(m.parents) && m.parents.length > 0) {
        const parentPlanetId = m.parents.find((p: any) => p && ('Planet' in p || 'planet' in p));
        if (parentPlanetId) {
          const id = parentPlanetId.Planet ?? parentPlanetId.planet;
          const parentBody = bodies.find((b) => b.body_id === id);
          if (parentBody) pName = parentBody.body_name;
        }
      }
      if (!pName) {
        const match = planets.find((p) => m.body_name.startsWith(p.body_name));
        if (match) pName = match.body_name;
      }

      const pPos = positions[pName] || [0, 0, 0];
      const subR = 5.0 + (mIdx % 4) * 3.0;
      const mAngle = (mIdx * 1.7 + 0.5) % (2 * Math.PI);
      const mInc = (mIdx % 2 === 0 ? 5 : -5) * (Math.PI / 180.0);

      // Орбита луны (36 точек)
      for (let s = 0; s <= 36; s++) {
        const phi = (2 * Math.PI * s) / 36;
        mOrbXs.push(pPos[0] + subR * Math.cos(phi));
        mOrbYs.push(pPos[1] + subR * Math.sin(phi) * Math.cos(mInc));
        mOrbZs.push(pPos[2] + subR * Math.sin(phi) * Math.sin(mInc));
      }
      mOrbXs.push(null);
      mOrbYs.push(null);
      mOrbZs.push(null);

      positions[m.body_name] = [
        pPos[0] + subR * Math.cos(mAngle),
        pPos[1] + subR * Math.sin(mAngle) * Math.cos(mInc),
        pPos[2] + subR * Math.sin(mAngle) * Math.sin(mInc),
      ];
    });

    // Стройплощадки и проекты
    const projectPositions: Record<string, [number, number, number]> = {};
    projects.forEach((prj, idx) => {
      const bName = prj.bodyName || '';
      const bPos = positions[bName] || [0, 0, 0];
      const dist = 3.5 + (idx + 1) * 2.5;
      const angle = (idx * 1.57 + 0.78) % (2 * Math.PI);
      projectPositions[prj.buildId || prj.buildName] = [
        bPos[0] + dist * Math.cos(angle),
        bPos[1] + dist * Math.sin(angle),
        bPos[2] + ((-1) ** idx) * 1.8,
      ];
    });

    const traces: any[] = [];

    // 1. Орбиты планет
    if (orbXs.length > 0) {
      traces.push({
        type: 'scatter3d',
        name: 'Орбиты планет',
        x: orbXs,
        y: orbYs,
        z: orbZs,
        mode: 'lines',
        line: { color: 'rgba(70, 105, 145, 0.45)', width: 2 },
        hoverinfo: 'skip',
        showlegend: true,
      });
    }

    // 2. Орбиты лун
    if (mOrbXs.length > 0) {
      traces.push({
        type: 'scatter3d',
        name: 'Орбиты лун',
        x: mOrbXs,
        y: mOrbYs,
        z: mOrbZs,
        mode: 'lines',
        line: { color: 'rgba(100, 130, 165, 0.35)', width: 1.5, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: true,
      });
    }

    // 3. Звезда
    if (primaryStar) {
      const pColor = getStarColor(primaryStar.sub_type || primaryStar.subType);
      traces.push({
        type: 'scatter3d',
        name: 'Звезда',
        x: [0],
        y: [0],
        z: [0],
        mode: 'markers+text',
        marker: {
          size: 20,
          color: pColor,
          line: { color: '#ffffff', width: 1.5 },
          opacity: 0.98,
        },
        text: [primaryStar.body_name],
        textposition: 'top center',
        textfont: { color: '#f1c40f', size: 12 },
        hovertext: [
          `<b>${primaryStar.body_name}</b><br>Класс: ${primaryStar.sub_type || primaryStar.subType || 'Звезда'}<br>Дистанция: 0 св. с`,
        ],
        hoverinfo: 'text',
        showlegend: true,
      });
    }

    // 4. Планеты
    if (planets.length > 0) {
      const pXs: number[] = [];
      const pYs: number[] = [];
      const pZs: number[] = [];
      const pTexts: string[] = [];
      const pHovers: string[] = [];
      const pColors: string[] = [];
      const pLineColors: string[] = [];
      const pSizes: number[] = [];

      planets.forEach((p) => {
        const pos = positions[p.body_name];
        if (!pos) return;
        pXs.push(pos[0]);
        pYs.push(pos[1]);
        pZs.push(pos[2]);
        pTexts.push(p.body_name);
        pColors.push(getBodyColor(p.sub_type || p.subType, p.body_type || p.type));

        const isLandable = Boolean(p.is_landable || p.landable || p.isLandable);
        pLineColors.push(isLandable ? '#00f3ff' : '#1e293b');

        const radKm = (p.radius_m || 6000000) / 1000;
        const sz = Math.max(7, Math.min(24, 7 + Math.log10(Math.max(100, radKm) / 1000) * 4.5));
        pSizes.push(sz);

        const lines = [
          `<b>${p.body_name}</b>`,
          `Класс: <b>${p.sub_type || p.subType || p.body_type || 'Тело'}</b>`,
          `Дистанция: ${Number(p.distance_ls || 0).toLocaleString('ru-RU')} св. с`,
        ];
        if (p.gravity) lines.push(`Гравитация: <b>${Number(p.gravity).toFixed(2)} G</b>`);
        if (p.surface_temp_k) lines.push(`Температура: <b>${Math.round(p.surface_temp_k)} K</b>`);
        if (p.atmosphere) lines.push(`Атмосфера: ${p.atmosphere}`);
        if (isLandable) lines.push("<span style='color:#00f3ff'>🛬 Пригодна для посадки</span>");
        if (p.bio_signals_count > 0) {
          lines.push(`<span style='color:#00ff88'>🌿 Биосигналы: <b>${p.bio_signals_count}</b></span>`);
        }
        pHovers.push(lines.join('<br>'));
      });

      if (pXs.length > 0) {
        traces.push({
          type: 'scatter3d',
          name: 'Планеты',
          x: pXs,
          y: pYs,
          z: pZs,
          mode: 'markers+text',
          marker: {
            size: pSizes,
            color: pColors,
            line: { color: pLineColors, width: 1.5 },
            opacity: 0.95,
          },
          text: pTexts,
          textposition: 'top center',
          textfont: { color: '#e2e8f0', size: 11 },
          hovertext: pHovers,
          hoverinfo: 'text',
          showlegend: true,
        });
      }
    }

    // 5. Луны
    if (moons.length > 0) {
      const mXs: number[] = [];
      const mYs: number[] = [];
      const mZs: number[] = [];
      const mTexts: string[] = [];
      const mHovers: string[] = [];
      const mColors: string[] = [];

      moons.forEach((m) => {
        const pos = positions[m.body_name];
        if (!pos) return;
        mXs.push(pos[0]);
        mYs.push(pos[1]);
        mZs.push(pos[2]);
        mTexts.push(m.body_name);
        mColors.push(getBodyColor(m.sub_type || m.subType, m.body_type || m.type));
        mHovers.push(
          `<b>${m.body_name}</b><br>Луна<br>Дистанция: ${Number(m.distance_ls || 0).toLocaleString('ru-RU')} св. с`
        );
      });

      if (mXs.length > 0) {
        traces.push({
          type: 'scatter3d',
          name: 'Луны',
          x: mXs,
          y: mYs,
          z: mZs,
          mode: 'markers+text',
          marker: {
            size: 5.5,
            color: mColors,
            line: { color: '#334155', width: 1 },
            opacity: 0.9,
          },
          text: mTexts,
          textposition: 'top center',
          textfont: { color: '#94a3b8', size: 9 },
          hovertext: mHovers,
          hoverinfo: 'text',
          showlegend: true,
        });
      }
    }

    // 6. Стройплощадки
    if (projects.length > 0) {
      const prjXs: number[] = [];
      const prjYs: number[] = [];
      const prjZs: number[] = [];
      const prjTexts: string[] = [];
      const prjHovers: string[] = [];
      const prjColors: string[] = [];

      projects.forEach((prj) => {
        const key = prj.buildId || prj.buildName;
        const pos = projectPositions[key];
        if (!pos) return;
        prjXs.push(pos[0]);
        prjYs.push(pos[1]);
        prjZs.push(pos[2]);
        prjTexts.push(`🏗️ ${prj.buildName} [${Math.round(prj.progress)}%]`);
        prjColors.push(prj.complete ? '#2ecc71' : '#ff8800');

        const lines = [
          `<b>🏗️ ${prj.buildName}</b>`,
          `Тип: ${prj.buildType || 'Постройка'}`,
          `Прогресс: <b>${prj.progress.toFixed(1)}%</b>`,
        ];
        if (prj.totalRequired) {
          lines.push(
            `Доставка: <b>${(prj.totalProvided || 0).toLocaleString('ru-RU')} / ${prj.totalRequired.toLocaleString('ru-RU')} т</b>`
          );
        }
        prjHovers.push(lines.join('<br>'));
      });

      if (prjXs.length > 0) {
        traces.push({
          type: 'scatter3d',
          name: 'Стройплощадки',
          x: prjXs,
          y: prjYs,
          z: prjZs,
          mode: 'markers+text',
          marker: {
            size: 11,
            symbol: 'diamond',
            color: prjColors,
            line: { color: '#ffffff', width: 1.5 },
            opacity: 1.0,
          },
          text: prjTexts,
          textposition: 'bottom center',
          textfont: { color: '#ff9f43', size: 11 },
          hovertext: prjHovers,
          hoverinfo: 'text',
          showlegend: true,
        });
      }
    }

    const layout = {
      paper_bgcolor: '#0b0e14',
      plot_bgcolor: '#07090e',
      margin: { l: 0, r: 0, t: 20, b: 0 },
      showlegend: true,
      legend: {
        bgcolor: 'rgba(11, 14, 20, 0.85)',
        bordercolor: '#1e293b',
        font: { color: '#cbd5e1', size: 10 },
        orientation: 'h',
        x: 0.01,
        y: 0.02,
      },
      hoverlabel: {
        bgcolor: '#0f172a',
        bordercolor: '#e67e22',
        font: { family: 'Consolas, monospace', size: 12, color: '#ffffff' },
        align: 'left',
      },
      scene: {
        bgcolor: '#07090e',
        xaxis: { showgrid: true, gridcolor: '#15202e', showticklabels: false, showbackground: false },
        yaxis: { showgrid: true, gridcolor: '#15202e', showticklabels: false, showbackground: false },
        zaxis: { showgrid: true, gridcolor: '#15202e', showticklabels: false, showbackground: false },
        camera: {
          eye: { x: 1.5, y: 1.5, z: 1.1 },
          up: { x: 0, y: 0, z: 1 },
        },
        aspectmode: 'data',
      },
      updatemenus: [
        {
          type: 'buttons',
          direction: 'left',
          x: 0.98,
          y: 0.98,
          xanchor: 'right',
          yanchor: 'top',
          bgcolor: '#1e293b',
          bordercolor: '#334155',
          font: { color: '#e2e8f0', size: 10 },
          buttons: [
            {
              label: '🔭 3D Orrery',
              method: 'relayout',
              args: [{ 'scene.camera': { eye: { x: 1.5, y: 1.5, z: 1.1 }, up: { x: 0, y: 0, z: 1 } } }],
            },
            {
              label: '🧭 Сверху (2D)',
              method: 'relayout',
              args: [{ 'scene.camera': { eye: { x: 0.001, y: 0.001, z: 2.5 }, up: { x: 0, y: 1, z: 0 } } }],
            },
            {
              label: '🔄 Сброс',
              method: 'relayout',
              args: [{ 'scene.camera': { eye: { x: 1.6, y: 1.6, z: 1.2 }, up: { x: 0, y: 0, z: 1 } } }],
            },
          ],
        },
      ],
    };

    const config = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
    };

    Plotly.newPlot(containerRef.current, traces, layout, config);

    const handleResize = () => {
      if (containerRef.current) {
        Plotly.Plots.resize(containerRef.current);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [scriptLoaded, bodies, projects, isFullscreen]);

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
  };

  return (
    <div
      style={{
        background: '#25282b',
        border: '1px solid #323538',
        borderRadius: 10,
        padding: isFullscreen ? 16 : 20,
        marginBottom: 24,
        position: isFullscreen ? 'fixed' : 'relative',
        top: isFullscreen ? 0 : 'auto',
        left: isFullscreen ? 0 : 'auto',
        width: isFullscreen ? '100vw' : '100%',
        height: isFullscreen ? '100vh' : 'auto',
        zIndex: isFullscreen ? 9999 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ fontSize: 18, color: '#eeeeee', margin: 0 }}>
            🪐 Интерактивная 3D-карта системы (Plotly Orrery)
          </h2>
          {bodies.length > 0 && (
            <span
              style={{
                fontSize: 12,
                color: '#9ca3af',
                background: '#1e2022',
                padding: '2px 8px',
                borderRadius: 4,
              }}
            >
              Тел: {bodies.length}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={toggleFullscreen}
            style={{
              background: '#323538',
              border: '1px solid #4a4d50',
              color: '#eeeeee',
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isFullscreen ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
            {isFullscreen ? 'Свернуть' : 'Полный экран'}
          </button>
        </div>
      </div>

      {loading && (
        <div
          style={{
            height: 380,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#07090e',
            borderRadius: 8,
            color: '#e67e22',
            fontSize: 14,
            gap: 10,
          }}
        >
          <IconRefreshCw size={18} className="animate-spin" /> Инициализация 3D-карты Plotly...
        </div>
      )}

      {error && !loading && (
        <div
          style={{
            height: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#07090e',
            borderRadius: 8,
            color: '#ef4444',
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && bodies.length === 0 && (
        <div
          style={{
            height: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#07090e',
            borderRadius: 8,
            color: '#9ca3af',
            fontSize: 13,
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div>Данные о телах системы не найдены в БД и EDSM.</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            Просканируйте систему в игре с запущенным Colonial Helper для загрузки орбит.
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: isFullscreen ? 'calc(100vh - 60px)' : 480,
          borderRadius: 8,
          overflow: 'hidden',
          display: loading || error || bodies.length === 0 ? 'none' : 'block',
        }}
      />
      {!loading && bodies.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280', textAlign: 'right' }}>
          ЛКМ: вращение 3D · ПКМ: перемещение · Колесо: зум · Клик по легенде: вкл/выкл слоёв
        </div>
      )}
    </div>
  );
}
