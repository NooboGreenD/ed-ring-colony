'use client';

/**
 * Интерактивная 3D-карта звездной системы (Plotly Orrery).
 *
 * Что изменилось по сравнению с первой версией (пункты ТЗ):
 *
 * 1. **Многозвёздные системы.** Тела группируются по *своей* звезде по цепочке
 *    `parents` (как в журнале/EDSM), а не «всё крутится вокруг главной». У
 *    каждой звезды свой кластер со своим бюджетом радиуса, поэтому системы из
 *    десятков звёзд читаемы: см. `src/lib/systemOrrery.ts`.
 * 2. **Приближение при фокусе на тело.** Фокус даёт настоящее сближение камеры:
 *    уровни «система → кластер звезды → окрестность тела → тело крупно»
 *    режут размах осей scene вокруг цели, а не просто сдвигают центр.
 * 3. **Наземные постройки — на поверхности.** В обзоре маркер стройки сидит на
 *    теле; в фокусе планета рисуется сферой, а постройки — по её поверхности
 *    (золотая спираль). Плюс список построек карточками в панели фокуса.
 * 4. **Мелкие значки.** Стройки/постройки 11 → 5.5 px, подписи только у цели,
 *    остальное — по ховеру; в плотных системах подписи режутся автоматически.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconMaximize,
  IconMinimize,
  IconRefreshCw,
  IconCrosshair,
  IconConstruction,
  IconArrowLeft,
  IconArrowRight,
} from '@/components/Icons';
import {
  buildOrreryLayout,
  bodySphereRadiusUnits,
  computeFocusView,
  sceneAspect,
  SPHERE_HAZE_SCALE,
  SPHERE_MATERIAL,
  SPHERE_MESH,
  neighboursOf,
  placeStructures,
  focusWindow,
  overviewWindow,
  sceneCamera,
  traceExtent,
  sphereGeometry,
  starColorFromTemperature,
  starRadiusScale,
  summarizeLayout,
  toStructures,
  type OrreryBody,
  type OrreryLayout,
  type OrreryStructure,
  type StructurePlacement,
} from '@/lib/systemOrrery';

declare global {
  interface Window {
    Plotly?: any;
  }
}

interface ResourceData {
  name: string;
  required?: number | null;
  provided?: number | null;
  remaining?: number;
  exact?: boolean;
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
  resources?: ResourceData[];
}

interface SystemPlotlyMapProps {
  systemName: string;
  projects?: ProjectData[];
  initialBodies?: any[];
  /** Внешняя цель фокуса (карточка проекта на странице системы). */
  focusTarget?: string;
  onFocusChange?: (target: string) => void;
}

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
  O: '#9bb0ff', B: '#bbccff', A: '#f8f9fa', F: '#fff4e8', G: '#ffd166',
  K: '#ff9e42', M: '#ff5533', L: '#b8432a', T: '#8b2a1a', Y: '#5c1b12',
  N: '#00d4ff', Neutron: '#00d4ff', H: '#4a0e4e', Black: '#2d004d',
  W: '#66aaff', C: '#ff4422', D: '#d8f0ff',
};

const ZOOM_STEPS = [
  { level: 0, label: 'Система', hint: 'Вся система целиком' },
  { level: 1, label: 'Кластер', hint: 'Только система выбранной звезды' },
  { level: 2, label: 'Окрестность', hint: 'Тело и соседи' },
  { level: 3, label: 'Поверхность', hint: 'Тело крупно: постройки на поверхности' },
] as const;

/**
 * Цвет звезды.
 *
 * Приоритет — настоящая температура поверхности (есть и в журнале, и в EDSM):
 * цвет считается как у излучения абсолютно чёрного тела. Спектральный класс
 * остаётся запасным вариантом для записей без температуры.
 */
function getStarColor(subType?: string | null, tempK = 0): string {
  const byTemperature = starColorFromTemperature(tempK);
  if (byTemperature) return byTemperature;
  const clean = (subType || '').trim();
  for (const [key, color] of Object.entries(STAR_SPECTRAL_COLORS)) {
    if (clean.toUpperCase().startsWith(key.toUpperCase())) return color;
  }
  return '#ffd166';
}

/**
 * Строки всплывающей подсказки с настоящими орбитальными элементами.

 * Пустой массив, когда элементов в данных нет: карта тогда строит орбиту по
 * прежней схеме и подписывать там нечего (иначе пользователь решит, что
 * «период 0 суток» — это правда).
 */
function orbitalHover(body: OrreryBody): string[] {
  const elements = body.elements;
  if (!elements || !elements.fromData) return [];
  const lines: string[] = ["<span style='color:#7f8fa6'>— орбита (по данным сканов) —</span>"];
  if (elements.semiMajorAxisLs > 0) {
    lines.push(`Большая полуось: <b>${formatNumber(elements.semiMajorAxisLs)}</b> св. с (${formatNumber(elements.semiMajorAxisLs / 499.00478)} а.е.)`);
  }
  if (elements.periodDays > 0) {
    lines.push(elements.periodDays >= 365
      ? `Период обращения: <b>${formatNumber(elements.periodDays / 365.25)}</b> лет`
      : `Период обращения: <b>${formatNumber(elements.periodDays)}</b> сут`);
  }
  lines.push(`Эксцентриситет: <b>${elements.eccentricity.toFixed(4)}</b>`);
  if (elements.inclinationDeg !== 0) lines.push(`Наклонение: <b>${elements.inclinationDeg.toFixed(2)}°</b>`);
  if (elements.periapsisDeg !== 0) lines.push(`Аргумент перицентра: <b>${elements.periapsisDeg.toFixed(2)}°</b>`);
  if (elements.axialTiltDeg !== 0) lines.push(`Наклон оси: <b>${elements.axialTiltDeg.toFixed(2)}°</b>`);
  return lines;
}

function getBodyColor(subType?: string | null, bodyType?: string | null): string {
  const source = `${subType || ''} ${bodyType || ''}`.toLowerCase();
  for (const [key, color] of Object.entries(BODY_CLASS_COLORS)) {
    if (source.includes(key)) return color;
  }
  return '#8d99ae';
}

function measurePixels(element: HTMLElement | null): number {
  if (!element) return 900;
  const width = element.clientWidth || 900;
  const height = element.clientHeight || 470;
  return Math.max(240, Math.min(width, height * 1.6));
}

function formatNumber(value: number): string {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function shortName(name: string, systemName: string): string {
  if (!name) return '';
  if (systemName && name.toLowerCase().startsWith(systemName.trim().toLowerCase())) {
    const tail = name.slice(systemName.trim().length).trim();
    if (tail) return tail;
  }
  return name;
}

export default function SystemPlotlyMap({
  systemName,
  projects = [],
  initialBodies,
  focusTarget,
  onFocusChange,
}: SystemPlotlyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<any[]>(initialBodies || []);
  const [loading, setLoading] = useState<boolean>(!initialBodies || initialBodies.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [zoom, setZoom] = useState<0 | 1 | 2 | 3>(0);
  const [filterMode, setFilterMode] = useState<'all' | 'bio' | 'landable' | 'sites'>('all');
  const [scaleMode, setScaleMode] = useState<'orrery' | 'linear'>('orrery');
  const [labelMode, setLabelMode] = useState<'auto' | 'all' | 'none'>('auto');
  const [showMoons, setShowMoons] = useState(true);
  const [isolateCluster, setIsolateCluster] = useState(true);
  // Вид = направление камеры (3D-изометрия / сверху / сбоку). Зум делает размах
  // осей, поэтому переключение вида ничего не пересчитывает и не может увести
  // камеру в чёрный экран.
  const [viewMode, setViewMode] = useState<'iso' | 'top' | 'side'>('iso');
  const [hoveredBody, setHoveredBody] = useState<string>('');

  useEffect(() => {
    if (focusTarget) {
      setSelectedTarget(focusTarget);
      setZoom((current) => (current === 0 ? 2 : current));
    }
  }, [focusTarget]);

  const selectTarget = useCallback((name: string, level?: 0 | 1 | 2 | 3) => {
    setSelectedTarget(name);
    setZoom(name ? (level ?? 2) : 0);
    onFocusChange?.(name);
  }, [onFocusChange]);

  // Plotly грузится с CDN: на Vercel это дешевле, чем тащить ~3.5 MB в бандл.
  useEffect(() => {
    if (typeof window === 'undefined') return;
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

  useEffect(() => {
    if (initialBodies && initialBodies.length > 0) {
      setRecords(initialBodies);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/atlas/system-bodies?system=${encodeURIComponent(systemName)}`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.bodies)) setRecords(data.bodies);
      })
      .catch((err) => console.warn('[SystemPlotlyMap] Failed fetching bodies:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [systemName, initialBodies]);

  const structures: OrreryStructure[] = useMemo(() => toStructures(projects), [projects]);

  const layout: OrreryLayout = useMemo(
    () => buildOrreryLayout(records, systemName, { scaleMode, showMoons, structureCount: structures.length }),
    [records, systemName, scaleMode, showMoons, structures.length],
  );

  const summary = useMemo(() => summarizeLayout(layout, structures), [layout, structures]);

  const canvasPixels = measurePixels(containerRef.current);

  const activeCluster = useMemo(() => {
    if (!selectedTarget) return null;
    return layout.clusters.find((cluster) =>
      cluster.starName === selectedTarget || cluster.bodies.some((body) => body.name === selectedTarget),
    ) ?? null;
  }, [layout, selectedTarget]);

  const focus = useMemo(
    () => (selectedTarget ? computeFocusView(layout, selectedTarget, zoom, canvasPixels) : null),
    [layout, selectedTarget, zoom, canvasPixels],
  );

  const halfSpan = focus ? focus.halfSpan : layout.span;
  const detailMode = zoom >= 2 && Boolean(selectedTarget) && selectedTarget !== focus?.clusterName;

  /** Радиус «символической» сферы фокусируемого тела — для построек на поверхности. */
  const sphereRadii = useMemo(() => {
    if (!selectedTarget || !focus) return {};
    if (zoom === 2 && !detailMode) return {};
    if (layout.byName[selectedTarget]?.kind === 'star') return {};
    const fraction = zoom === 3 ? 0.42 : 0.14;
    return { [selectedTarget]: bodySphereRadiusUnits(focus.halfSpan, fraction) };
  }, [selectedTarget, focus, zoom, layout, detailMode]);

  const placements: StructurePlacement[] = useMemo(
    () => placeStructures(layout, structures, halfSpan, canvasPixels, sphereRadii),
    [layout, structures, halfSpan, canvasPixels, sphereRadii],
  );

  const visibleStructures = useMemo(() => {
    if (!selectedTarget || zoom === 0 || !isolateCluster || !activeCluster?.starName) return placements;
    const names = new Set((activeCluster.bodies ?? []).map((body: OrreryBody) => body.name));
    names.add(activeCluster.starName);
    return placements.filter((placement) => !placement.anchorName || names.has(placement.anchorName));
  }, [placements, selectedTarget, zoom, isolateCluster, activeCluster]);

  const showLabels = labelMode === 'all'
    || (labelMode === 'none' ? false : layout.labelMode === 'all');

  const structuresForBody = useCallback(
    (bodyName: string) => placements
      .filter((placement) => placement.anchorName === bodyName)
      .map((placement) => placement.structure),
    [placements],
  );

  useEffect(() => {
    if (!scriptLoaded || !window.Plotly || !containerRef.current) return;
    if (loading || error || records.length === 0) return;

    const Plotly = window.Plotly;
    const gd = containerRef.current;
    const inCluster = (owner: string) => {
      if (!selectedTarget || zoom === 0 || !isolateCluster || !activeCluster?.starName) return true;
      return owner === activeCluster.starName || owner === '';
    };

    const linesFrom = (paths: { points: [number, number, number][]; owner: string }[]) => {
      const x: (number | null)[] = [];
      const y: (number | null)[] = [];
      const z: (number | null)[] = [];
      for (const path of paths) {
        if (!inCluster(path.owner)) continue;
        for (const point of path.points) {
          x.push(point[0]);
          y.push(point[1]);
          z.push(point[2]);
        }
        x.push(null);
        y.push(null);
        z.push(null);
      }
      return { x, y, z };
    };

    const traces: any[] = [];

    // ── 1. Обитаемая зона (своя у каждой звезды) ──────────────────────────
    const hzPaths = layout.hzPaths.filter((path) => inCluster(path.owner));
    if (hzPaths.length > 0) {
      const hz = linesFrom(hzPaths);
      traces.push({
        type: 'scatter3d',
        name: '🌱 Обитаемая зона',
        x: hz.x, y: hz.y, z: hz.z,
        mode: 'lines',
        line: { color: 'rgba(46, 204, 113, 0.3)', width: 2, dash: 'dash' },
        hoverinfo: 'skip',
        legendgroup: 'hz',
        showlegend: true,
      });
    }

    // ── 2. Орбиты ─────────────────────────────────────────────────────────
    const planetOrbits = linesFrom(layout.orbits);
    if (planetOrbits.x.length > 0) {
      traces.push({
        type: 'scatter3d',
        name: 'Орбиты',
        x: planetOrbits.x, y: planetOrbits.y, z: planetOrbits.z,
        mode: 'lines',
        line: { color: detailMode ? 'rgba(70, 105, 145, 0.28)' : 'rgba(70, 105, 145, 0.45)', width: 1.6 },
        hoverinfo: 'skip',
        legendgroup: 'orbits',
        showlegend: true,
      });
    }

    const moonOrbits = linesFrom(layout.moonOrbits);
    if (showMoons && moonOrbits.x.length > 0) {
      traces.push({
        type: 'scatter3d',
        name: 'Орбиты лун',
        x: moonOrbits.x, y: moonOrbits.y, z: moonOrbits.z,
        mode: 'lines',
        line: { color: 'rgba(100, 130, 165, 0.3)', width: 1.2, dash: 'dot' },
        hoverinfo: 'skip',
        legendgroup: 'moon_orbits',
        showlegend: layout.bodies.some((body) => body.kind === 'moon'),
      });
    }

    const ringLines = linesFrom(layout.ringPaths);
    if (ringLines.x.length > 0) {
      traces.push({
        type: 'scatter3d',
        name: '💍 Кольца',
        x: ringLines.x, y: ringLines.y, z: ringLines.z,
        mode: 'lines',
        line: { color: 'rgba(159, 216, 239, 0.55)', width: 2 },
        hoverinfo: 'skip',
        legendgroup: 'rings',
        showlegend: true,
      });
    }

    // ── 3. Звёзды одним трэком — их могут быть десятки ─────────────────────
    const visibleStars = layout.stars.filter((star) => inCluster(star.name) || star.name === selectedTarget);
    if (visibleStars.length > 0) {
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      const colors: string[] = [];
      const sizes: number[] = [];
      const texts: string[] = [];
      const hovers: string[] = [];
      const custom: string[] = [];
      const lineColors: string[] = [];
      const lineWidths: number[] = [];
      for (const star of visibleStars) {
        const point = layout.positions[star.name];
        if (!point) continue;
        const selected = star.name === selectedTarget;
        xs.push(point[0]); ys.push(point[1]); zs.push(point[2]);
        colors.push(getStarColor(star.subType, star.tempK));
        // Размер — по настоящему радиусу звезды: сверхгигант обязан быть
        // заметно крупнее красного карлика, а не отличаться на пару пикселей.
        const starSize = (layout.markerSizes[star.name] ?? 14) * starRadiusScale(star);
        sizes.push(selected ? Math.min(38, starSize * 1.25) : starSize);
        texts.push(showLabels || selected ? shortName(star.name, systemName) : '');
        lineColors.push(selected ? '#00f3ff' : 'rgba(255,255,255,0.65)');
        lineWidths.push(selected ? 2 : 0.8);
        hovers.push([
          `<b>${star.name}</b>`,
          `Звезда · класс <b>${star.subType || '?'}</b>`,
          star.distanceLs > 0 ? `От точки прибытия: ${formatNumber(star.distanceLs)} св. с` : 'Главная звезда системы',
          star.tempK > 0 ? `Температура: ${Math.round(star.tempK)} K` : '',
          `Тел в кластере: ${(layout.clusters.find((cluster) => cluster.starName === star.name)?.bodies.length ?? 0)}`,
          '',
          '<span style="color:#64748b">клик — фокус на звезде</span>',
        ].join('<br>'));
        custom.push(star.name);
      }
      traces.push({
        type: 'scatter3d',
        name: `★ Звёзды (${layout.stars.length})`,
        x: xs, y: ys, z: zs,
        mode: 'markers+text',
        marker: { size: sizes, color: colors, line: { color: lineColors, width: lineWidths }, opacity: 0.98 },
        text: texts,
        textposition: 'top center',
        textfont: { color: '#f1c40f', size: 9 },
        customdata: custom,
        hovertext: hovers,
        hoverinfo: 'text',
        legendgroup: 'stars',
        showlegend: true,
        meta: 'focus',
      });
    }

    // ── 4. Сферы планет в режиме «окрестность/поверхность» ─────────────────
    for (const [bodyName, radius] of Object.entries(sphereRadii)) {
      const center = layout.positions[bodyName];
      const body = layout.byName[bodyName];
      if (!center || !body) continue;
      const mesh = sphereGeometry(center, radius, SPHERE_MESH[0], SPHERE_MESH[1]);
      traces.push({
        type: 'mesh3d',
        name: `${bodyName}`,
        x: mesh.x, y: mesh.y, z: mesh.z,
        i: mesh.i, j: mesh.j, k: mesh.k,
        color: getBodyColor(body.subType, String(body.raw.body_type ?? body.raw.type ?? '')),
        hoverinfo: 'skip',
        showlegend: false,
        legendgroup: 'focus_body',
        ...SPHERE_MATERIAL,
      });
      if (body.atmosphere && !/no atmosphere/i.test(body.atmosphere)) {
        // Дымка — своя, более грубая сетка: у mesh3d индексы граней живут вместе
        // с вершинами, поэтому размерность обязана совпадать с числом вершин.
        const hazeSegments = Math.max(12, Math.floor(SPHERE_MESH[0] * 0.8));
        const hazeRings = Math.max(8, Math.floor(SPHERE_MESH[1] * 0.8));
        const haze = sphereGeometry(center, radius * SPHERE_HAZE_SCALE, hazeSegments, hazeRings);
        traces.push({
          type: 'mesh3d',
          name: 'Атмосфера',
          x: haze.x, y: haze.y, z: haze.z,
          i: haze.i, j: haze.j, k: haze.k,
          color: 'rgba(120, 190, 255, 0.16)',
          opacity: 0.35,
          lighting: { ambient: 0.7, diffuse: 0.2, specular: 0, roughness: 1, fresnel: 0.5 },
          flatshading: false,
          hoverinfo: 'skip',
          showlegend: false,
          legendgroup: 'focus_body',
        });
      }
    }

    // ── 5. Планеты и луны ─────────────────────────────────────────────────
    const inFilter = (body: OrreryBody) => {
      if (body.kind === 'moon' && !showMoons) return false;
      if (filterMode === 'bio') return body.bioSignals > 0;
      if (filterMode === 'landable') return body.landable;
      if (filterMode === 'sites') return structuresForBody(body.name).length > 0;
      return true;
    };
    const inScope = (body: OrreryBody) => {
      if (inCluster(body.starKey ?? '')) return true;
      return body.name === selectedTarget;
    };
    const orbiters = layout.bodies.filter((body) => body.kind !== 'star' && inFilter(body) && inScope(body));
    const detailScale = detailMode ? 1.15 : 1;

    for (const [kind, label] of [['planet', 'Планеты'], ['moon', 'Луны']] as const) {
      const list = orbiters.filter((body) => body.kind === kind);
      if (list.length === 0) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      const colors: string[] = [];
      const sizes: number[] = [];
      const texts: string[] = [];
      const hovers: string[] = [];
      const custom: string[] = [];
      const lineColors: string[] = [];
      for (const body of list) {
        const point = layout.positions[body.name];
        if (!point) continue;
        const selected = body.name === selectedTarget;
        const hovered = body.name === hoveredBody;
        // Тело, ради которого включён режим сферы, не дублируем маркером.
        if (sphereRadii[body.name]) continue;
        xs.push(point[0]); ys.push(point[1]); zs.push(point[2]);
        colors.push(getBodyColor(body.subType, String(body.raw.body_type ?? body.raw.type ?? '')));
        sizes.push((layout.markerSizes[body.name] ?? 7) * (selected || hovered ? 1.3 : 1) * detailScale);
        const withSite = structuresForBody(body.name).length;
        texts.push(selected || hovered || showLabels ? shortName(body.name, systemName) : '');
        lineColors.push(selected ? '#00f3ff' : body.landable ? 'rgba(0,243,255,0.7)' : body.bioSignals > 0 ? 'rgba(0,255,136,0.65)' : 'rgba(30,41,59,0.9)');
        hovers.push([
          `<b>${body.name}</b>`,
          `Класс: <b>${body.subType || '—'}</b>`,
          body.distanceLs > 0 ? `Дистанция: ${formatNumber(body.distanceLs)} св. с` : '',
          body.radiusM > 0 ? `Радиус: ${formatNumber(Math.round(body.radiusM / 1000))} км` : '',
          body.gravity > 0 ? `Гравитация: <b>${(body.gravity / 9.80665).toFixed(2)} g</b>` : '',
          body.tempK > 0 ? `Температура: <b>${Math.round(body.tempK)} K</b>` : '',
          body.atmosphere ? `Атмосфера: ${body.atmosphere}` : '',
          body.volcanism ? `Вулканизм: ${body.volcanism}` : '',
          body.landable ? "<span style='color:#00f3ff'>🛬 посадка возможна</span>" : '',
          body.bioSignals > 0 ? `<span style='color:#00ff88'>🌿 биосигналы: <b>${body.bioSignals}</b></span>` : '',
          body.rings.length > 0 ? `<span style='color:#9fd8ef'>💍 кольца: <b>${body.rings.length}</b></span>` : '',
          withSite > 0 ? `<span style='color:#ff9f43'>🏗 постройки на теле: <b>${withSite}</b></span>` : '',
          body.firstDiscoveredBy ? `<span style='color:#94a3b8'>открыто: CMDR ${body.firstDiscoveredBy}</span>` : '',
          // Настоящие орбитальные элементы — то, по чему построена орбита.
          ...orbitalHover(body),
          '',
          '<span style="color:#64748b">клик — фокус · двойной клик — поверхность</span>',
        ].filter(Boolean).join('<br>'));
        custom.push(body.name);
      }
      if (xs.length === 0) continue;
      traces.push({
        type: 'scatter3d',
        name: label,
        x: xs, y: ys, z: zs,
        mode: 'markers+text',
        marker: { size: sizes, color: colors, line: { color: lineColors, width: selectedTarget ? 1.2 : 0.8 }, opacity: detailMode ? 0.9 : 0.96 },
        text: texts,
        textposition: 'top center',
        textfont: { color: '#e2e8f0', size: zoom >= 2 ? 10 : 9 },
        customdata: custom,
        hovertext: hovers,
        hoverinfo: 'text',
        legendgroup: kind,
        showlegend: true,
        meta: 'focus',
      });
    }

    // ── 6. Постройки: на теле (обзор) или на поверхности (фокус) ───────────
    const siteTraces = buildStructureTraces(visibleStructures, layout, selectedTarget, zoom);
    traces.push(...siteTraces);

    // ── 7. Кольцо-прицел цели ──────────────────────────────────────────────
    if (focus && selectedTarget) {
      const ringRadius = sphereRadii[selectedTarget]
        ? sphereRadii[selectedTarget] * 1.28
        : Math.max(halfSpan * 0.06, 1.2);
      const points: [number, number, number][] = [];
      for (let step = 0; step <= 56; step += 1) {
        const phi = (Math.PI * 2 * step) / 56;
        points.push([
          focus.center[0] + ringRadius * Math.cos(phi),
          focus.center[1] + ringRadius * Math.sin(phi),
          focus.center[2],
        ]);
      }
      traces.push({
        type: 'scatter3d',
        name: `🎯 ${shortName(selectedTarget, systemName)}`,
        x: points.map((point) => point[0]),
        y: points.map((point) => point[1]),
        z: points.map((point) => point[2]),
        mode: 'lines',
        line: { color: 'rgba(0, 243, 255, 0.75)', width: 2 },
        hoverinfo: 'skip',
        legendgroup: 'target',
        showlegend: true,
      });
    }

    // Обзор = куб по габариту реально нарисованных точек: орбиты, кольца и HZ
    // выходят за бюджет `span`, и ±span обрезал их края («вся система не
    // влазит, часть орбит порезана»).
    const overviewSpan = overviewWindow(traceExtent(traces), layout.span);
    // Окно фокуса с тем же запасом, что в `orrery.focus_window` (приложение):
    // иначе сфера тела и постройки на ней липнут к краю рамки.
    const focusSpan = focusWindow(halfSpan);
    const ranges = focus && zoom > 0
      ? {
        x: [focus.center[0] - focusSpan, focus.center[0] + focusSpan] as [number, number],
        y: [focus.center[1] - focusSpan, focus.center[1] + focusSpan] as [number, number],
        z: [focus.center[2] - focusSpan, focus.center[2] + focusSpan] as [number, number],
      }
      : {
        x: [-overviewSpan, overviewSpan] as [number, number],
        y: [-overviewSpan, overviewSpan] as [number, number],
        z: [-overviewSpan, overviewSpan] as [number, number],
      };

    const scene: any = {
      bgcolor: '#07090e',
      // camera.center — нормализованные единицы сцены, поэтому всегда 0: центр
      // окна уже задан размахом осей. Координата цели в unit'ах системы увела бы
      // камеру в никуда (чёрный экран при фокусе).
      camera: sceneCamera(viewMode),
      // Куб вместо «data»: иначе сплющенная по z система превращает шары в блины.
      ...sceneAspect(),
      xaxis: { showgrid: false, showticklabels: false, showbackground: false, zeroline: false, range: ranges.x },
      yaxis: { showgrid: false, showticklabels: false, showbackground: false, zeroline: false, range: ranges.y },
      zaxis: { showgrid: false, showticklabels: false, showbackground: false, zeroline: false, range: ranges.z },
    };

    Plotly.react(gd, traces, {
      paper_bgcolor: '#0b0e14',
      plot_bgcolor: '#07090e',
      margin: { l: 0, r: 0, t: 4, b: 0 },
      showlegend: summary.stars + layout.bodies.length <= 400,
      legend: {
        bgcolor: 'rgba(11, 14, 20, 0.78)',
        bordercolor: '#1e293b',
        borderwidth: 1,
        font: { color: '#cbd5e1', size: 9 },
        orientation: 'h',
        x: 0.004,
        y: 0.012,
      },
      hoverlabel: {
        bgcolor: '#0f172a',
        bordercolor: '#e67e22',
        font: { family: 'Consolas, monospace', size: 11, color: '#ffffff' },
        align: 'left',
      },
      scene,
    }, { responsive: true, displayModeBar: false, displaylogo: false, scrollZoom: true });

    const gdAny = gd as any;
    if (!gdAny.__edMapBound && typeof gdAny.on === 'function') {
      gdAny.__edMapBound = true;
      gdAny.on('plotly_click', (event: any) => {
        const point = event?.points?.[0] ?? event?.data?.[0];
        const name = String(point?.customdata ?? point?.data?.customdata?.[point?.pointNumber ?? 0] ?? '');
        if (name) selectTarget(name, 2);
      });
      gdAny.on('plotly_doubleclick', (event: any) => {
        const point = event?.points?.[0] ?? event?.data?.[0];
        const name = String(point?.customdata ?? '');
        if (name) selectTarget(name, 3);
      });
      gdAny.on('plotly_hover', (event: any) => {
        const point = event?.points?.[0];
        const name = point?.customdata;
        if (typeof name === 'string' && name) setHoveredBody(name);
      });
      gdAny.on('plotly_unhover', () => setHoveredBody(''));
    }
  }, [
    scriptLoaded, loading, error, records, layout, structures, visibleStructures, selectedTarget, zoom,
    filterMode, scaleMode, labelMode, showMoons, isolateCluster, activeCluster, focus, halfSpan, detailMode,
    sphereRadii, hoveredBody, isFullscreen, showLabels, systemName, summary, structuresForBody, selectTarget,
    canvasPixels, viewMode,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        selectTarget('', 0);
      } else if (event.key === '[' || event.key === 'ArrowLeft') {
        cycleTarget(-1);
      } else if (event.key === ']' || event.key === 'ArrowRight') {
        cycleTarget(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTarget, layout, zoom]);

  function cycleTarget(direction: number) {
    const names = layout.bodies.map((body) => body.name);
    if (names.length === 0) return;
    const index = selectedTarget ? names.indexOf(selectedTarget) : -1;
    const next = names[(index + direction + names.length) % names.length];
    selectTarget(next, zoom === 0 ? 2 : zoom);
  }

  const focusBody = selectedTarget ? layout.byName[selectedTarget] ?? null : null;
  const focusStructures = selectedTarget ? structuresForBody(selectedTarget) : [];
  const neighbours = selectedTarget ? neighboursOf(layout, selectedTarget, 5) : [];
  const focusProjectRows = useMemo(() => {
    if (!selectedTarget) return [] as { structure: OrreryStructure; project?: ProjectData }[];
    const byId = new Map(projects.map((project) => [String(project.buildId), project]));
    return focusStructures.map((structure) => ({
      structure,
      project: byId.get(String(structure.id)),
    }));
  }, [focusStructures, selectedTarget, projects]);

  return (
    <div
      style={{
        background: '#25282b',
        border: '1px solid #323538',
        borderRadius: 10,
        padding: isFullscreen ? 14 : 18,
        marginBottom: 24,
        position: isFullscreen ? 'fixed' : 'relative',
        inset: isFullscreen ? 0 : 'auto',
        width: isFullscreen ? '100vw' : '100%',
        height: isFullscreen ? '100vh' : 'auto',
        zIndex: isFullscreen ? 9999 : 1,
      }}
    >
      <style>{`
        .ed-map-chip{border:1px solid #4a4d50;background:#1e2022;color:#cbd5e1;border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap;transition:all .15s ease}
        .ed-map-chip:hover:not(:disabled){border-color:#e67e22;color:#ff9f43}
        .ed-map-chip:disabled{opacity:.4;cursor:not-allowed}
        .ed-map-chip[data-on="1"]{background:#e67e22;border-color:#e67e22;color:#0b0e14;font-weight:600}
        .ed-map-chip[data-tone="cyan"][data-on="1"]{background:#00f3ff;border-color:#00f3ff;color:#04222a}
        .ed-map-chip[data-tone="green"][data-on="1"]{background:#2ecc71;border-color:#2ecc71;color:#04240f}
        .ed-map-chip[data-tone="violet"][data-on="1"]{background:#b39ddb;border-color:#b39ddb;color:#1b1230}
        .ed-map-scroll{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}
        .ed-map-scroll::-webkit-scrollbar{height:6px}
        .ed-map-scroll::-webkit-scrollbar-thumb{background:#3a3d40;border-radius:3px}
        .ed-map-card{background:#25282b;border:1px solid #323538;border-radius:6px;padding:7px 9px}
        .ed-map-card[data-target="1"]{border-color:#00f3ff}
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 17, color: '#eeeeee', margin: 0 }}>🪐 3D-карта системы</h2>
          <span style={{ fontSize: 11, color: '#9ca3af', background: '#1e2022', padding: '2px 8px', borderRadius: 4 }}>
            ★ {summary.stars || '—'} · тел {layout.bodies.length}
            {summary.planets ? ` · планет ${summary.planets}` : ''}
            {summary.moons ? ` · лун ${summary.moons}` : ''}
            {summary.ringedBodies ? ` · кольца ${summary.ringedBodies}` : ''}
          </span>
          {summary.activeSites > 0 && (
            <span style={{ fontSize: 11, color: '#ff9f43', background: 'rgba(230,126,34,0.14)', padding: '2px 8px', borderRadius: 4 }}>
              <IconConstruction size={11} /> строек {summary.activeSites}
            </span>
          )}
          {summary.bioSignals > 0 && (
            <span style={{ fontSize: 11, color: '#22c55e', background: 'rgba(34,197,94,0.14)', padding: '2px 8px', borderRadius: 4 }}>
              🌿 {summary.bioSignals}
            </span>
          )}
          {summary.stars > 1 && (
            <span style={{ fontSize: 11, color: '#9fd8ef', background: 'rgba(159,216,239,0.12)', padding: '2px 8px', borderRadius: 4 }}>
              мультизвёздная
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={selectedTarget}
            onChange={(event) => selectTarget(event.target.value, event.target.value ? 2 : 0)}
            style={{
              background: '#1e2022', border: '1px solid #4a4d50', color: '#e2e8f0',
              padding: '5px 8px', borderRadius: 6, fontSize: 12, cursor: 'pointer', maxWidth: 250,
            }}
          >
            <option value="">🎯 без фокуса (всю систему)</option>
            {layout.stars.map((star) => (
              <option key={`star-${star.name}`} value={star.name}>★ {star.name}</option>
            ))}
            {layout.bodies.filter((body) => body.kind !== 'star').map((body) => (
              <option key={body.name} value={body.name}>
                {body.kind === 'moon' ? '☾ ' : '● '}{body.name}
                {body.bioSignals > 0 ? ` · 🌿${body.bioSignals}` : ''}{structuresForBody(body.name).length ? ' · 🏗' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => cycleTarget(-1)} className="ed-map-chip" title="Предыдущее тело (←)"><IconArrowLeft size={12} /></button>
          <button onClick={() => cycleTarget(1)} className="ed-map-chip" title="Следующее тело (→)"><IconArrowRight size={12} /></button>
          <button onClick={() => selectTarget('', 0)} className="ed-map-chip" title="Снять фокус (Esc)">
            <IconCrosshair size={12} /> сброс
          </button>
          {([
            ['iso', '🔭 3D', 'изометрия — как видит систему наблюдатель'],
            ['top', '🧭 сверху', 'плоский вид на плоскость эклиптики (та же сцена)'],
            ['side', '📐 сбоку', 'профиль: видно наклонение орбит'],
          ] as const).map(([mode, label, hint]) => (
            <button
              key={mode}
              className="ed-map-chip"
              data-on={viewMode === mode ? '1' : '0'}
              title={hint}
              onClick={() => setViewMode(mode)}
            >
              {label}
            </button>
          ))}
          <button onClick={() => setIsFullscreen((value) => !value)} className="ed-map-chip">
            {isFullscreen ? <IconMinimize size={12} /> : <IconMaximize size={12} />}
            {isFullscreen ? 'свернуть' : 'во весь экран'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        {([
          ['all', 'все тела', ''],
          ['bio', '🌿 био', 'green'],
          ['landable', '🛬 посадка', 'cyan'],
          ['sites', '🏗 стройки', ''],
        ] as const).map(([mode, label, tone]) => (
          <button
            key={mode}
            className="ed-map-chip"
            data-on={filterMode === mode ? '1' : '0'}
            data-tone={tone || undefined}
            onClick={() => setFilterMode(mode)}
          >
            {label}
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: '#3a3d40', margin: '0 2px' }} />
        {ZOOM_STEPS.map((step) => (
          <button
            key={step.level}
            className="ed-map-chip"
            data-on={(selectedTarget ? zoom === step.level : step.level === 0) ? '1' : '0'}
            disabled={!selectedTarget && step.level > 0}
            onClick={() => setZoom(step.level)}
            title={selectedTarget ? step.hint : 'Сначала выберите тело'}
          >
            🔍 {step.label}
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: '#3a3d40', margin: '0 2px' }} />
        <button className="ed-map-chip" data-on={showMoons ? '1' : '0'} onClick={() => setShowMoons((value) => !value)} title="Показывать луны и их орбиты">☾ луны</button>
        <button
          className="ed-map-chip"
          data-on={isolateCluster && !!selectedTarget ? '1' : '0'}
          onClick={() => setIsolateCluster((value) => !value)}
          title="В фокусе показывать только кластер выбранной звезды"
        >
          ⧉ изолировать
        </button>
        <button
          className="ed-map-chip"
          data-on={labelMode === 'all' ? '1' : '0'}
          data-tone="violet"
          onClick={() => setLabelMode((value) => (value === 'all' ? 'auto' : value === 'auto' ? 'none' : 'all'))}
          title="Подписи: авто → все → выкл"
        >
          Aa {labelMode === 'auto' ? 'авто' : labelMode === 'all' ? 'все' : 'нет'}
        </button>
        <button
          className="ed-map-chip"
          data-on={scaleMode === 'linear' ? '1' : '0'}
          onClick={() => setScaleMode((value) => (value === 'orrery' ? 'linear' : 'orrery'))}
          title="Лог-сжатие орбит (orrery) или честные св. секунды"
        >
          {scaleMode === 'orrery' ? '📏 лог-масштаб' : '📏 реальные LS'}
        </button>
      </div>

      {layout.clusters.length > 1 && (
        <div className="ed-map-scroll" style={{ marginBottom: 8 }}>
          {layout.clusters.map((cluster) => (
            <button
              key={cluster.starName || 'none'}
              className="ed-map-chip"
              data-on={activeCluster?.starName === cluster.starName ? '1' : '0'}
              onClick={() => selectTarget(cluster.starName, 1)}
              title={`${cluster.starName} · тел: ${cluster.bodies.length}`}
            >
              ★ {shortName(cluster.starName, systemName) || 'без звезды'}
              <span style={{ color: '#6b7280', marginLeft: 6 }}>{cluster.bodies.length}</span>
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ height: 380, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07090e', borderRadius: 8, color: '#e67e22', fontSize: 14, gap: 10 }}>
          <IconRefreshCw size={18} /> Инициализация 3D-карты Plotly...
        </div>
      )}

      {error && !loading && (
        <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07090e', borderRadius: 8, color: '#ef4444', fontSize: 14 }}>
          {error}
        </div>
      )}

      {!loading && !error && records.length === 0 && (
        <div style={{ height: 170, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07090e', borderRadius: 8, color: '#9ca3af', fontSize: 13, flexDirection: 'column', gap: 8 }}>
          <div>Данных о телах системы нет ни в БД проекта, ни в EDSM.</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>Просканируйте систему с запущенным Colonial Helper — сканы уйдут в system_scans.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 520px', minWidth: 300 }}>
          <div
            ref={containerRef}
            style={{
              width: '100%',
              height: isFullscreen ? 'calc(100vh - 190px)' : 470,
              borderRadius: 8,
              overflow: 'hidden',
              display: loading || error || records.length === 0 ? 'none' : 'block',
            }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>колесо — зум · ЛКМ — вращение · ПКМ — панорама · клик по телу — фокус · двойной клик — поверхность · ←/→ — перебор тел</span>
            {selectedTarget && <span style={{ color: '#00f3ff' }}>🎯 {selectedTarget}</span>}
          </div>
        </div>

        <FocusPanel
          body={focusBody}
          structures={focusProjectRows}
          neighbours={neighbours}
          systemName={systemName}
          onPick={(name, level) => selectTarget(name, level)}
          onClose={() => selectTarget('', 0)}
          isFullscreen={isFullscreen}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────── построка треков построек ─────────────────────────────── */

function buildStructureTraces(
  placements: StructurePlacement[],
  layout: OrreryLayout,
  selectedTarget: string,
  zoom: number,
): any[] {
  if (placements.length === 0) return [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const colors: string[] = [];
  const sizes: number[] = [];
  const texts: string[] = [];
  const hovers: string[] = [];
  const custom: string[] = [];
  const linkX: (number | null)[] = [];
  const linkY: (number | null)[] = [];
  const linkZ: (number | null)[] = [];

  for (const placement of placements) {
    const { structure, position, anchorName, onSurface } = placement;
    const selected = Boolean(anchorName) && anchorName === selectedTarget;
    xs.push(position[0]); ys.push(position[1]); zs.push(position[2]);
    colors.push(structure.complete ? '#2ecc71' : '#ff8800');
    sizes.push(selected ? 9 : 5.5);
    texts.push(selected || zoom === 3 ? `🏗 ${structure.name}` : '');
    hovers.push([
      `<b>🏗 ${structure.name}</b>`,
      `тип: ${structure.type}`,
      `тело: ${structure.bodyName || 'не привязано'}`,
      `прогресс: <b>${structure.progress.toFixed(1)}%</b>`,
      structure.requiredTons > 0
        ? `доставка: <b>${formatNumber(structure.providedTons)} / ${formatNumber(structure.requiredTons)} т</b>`
        : '',
      onSurface
        ? "<span style='color:#2ecc71'>наземная постройка (на поверхности тела)</span>"
        : "<span style='color:#94a3b8'>объект на орбите</span>",
    ].filter(Boolean).join('<br>'));
    custom.push(anchorName ?? '');
    const anchor = anchorName ? layout.positions[anchorName] : null;
    if (anchor && selected) {
      linkX.push(anchor[0], position[0], null);
      linkY.push(anchor[1], position[1], null);
      linkZ.push(anchor[2], position[2], null);
    }
  }

  const traces: any[] = [{
    type: 'scatter3d',
    name: `🏗 Постройки (${placements.length})`,
    x: xs, y: ys, z: zs,
    mode: 'markers+text',
    marker: { size: sizes, symbol: 'diamond', color: colors, line: { color: '#0b0e14', width: 0.6 }, opacity: 1 },
    text: texts,
    textposition: 'bottom center',
    textfont: { color: '#ff9f43', size: 8 },
    customdata: custom,
    hovertext: hovers,
    hoverinfo: 'text',
    legendgroup: 'sites',
    showlegend: true,
    meta: 'focus',
  }];

  if (linkX.length > 0) {
    traces.push({
      type: 'scatter3d',
      name: 'связь постройка ↔ тело',
      x: linkX, y: linkY, z: linkZ,
      mode: 'lines',
      line: { color: 'rgba(255, 159, 67, 0.6)', width: 1.2, dash: 'dot' },
      hoverinfo: 'skip',
      showlegend: false,
      legendgroup: 'sites',
    });
  }
  return traces;
}

/* ───────────────────────────────────── панель фокуса ───────────────────────────────────── */

function FocusPanel({
  body,
  structures,
  neighbours,
  systemName,
  onPick,
  onClose,
  isFullscreen,
}: {
  body: OrreryBody | null;
  structures: { structure: OrreryStructure; project?: ProjectData }[];
  neighbours: OrreryBody[];
  systemName: string;
  onPick: (name: string, level: 0 | 1 | 2 | 3) => void;
  onClose: () => void;
  isFullscreen: boolean;
}) {
  if (!body && structures.length === 0) return null;
  return (
    <div style={{
      flex: '0 1 330px', minWidth: 270, background: '#1e2022', border: '1px solid #323538',
      borderRadius: 8, padding: 12, maxHeight: isFullscreen ? 'calc(100vh - 190px)' : 470, overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#eeeeee', wordBreak: 'break-word' }}>{body?.name ?? systemName}</span>
        <button className="ed-map-chip" onClick={onClose}>✕</button>
      </div>

      {body && (
        <div style={{ fontSize: 12, color: '#9ca3af', display: 'grid', gap: 3 }}>
          <Row label="Класс" value={body.subType || (body.kind === 'star' ? 'Звезда' : 'Тело')} />
          <Row label="Тип" value={body.kind === 'star' ? 'звезда' : body.kind === 'moon' ? 'луна' : 'планета'} />
          {body.distanceLs > 0 && <Row label="Дистанция" value={`${formatNumber(body.distanceLs)} св. с`} />}
          {body.radiusM > 0 && <Row label="Радиус" value={`${formatNumber(Math.round(body.radiusM / 1000))} км`} />}
          {body.gravity > 0 && <Row label="Гравитация" value={`${(body.gravity / 9.80665).toFixed(2)} g`} />}
          {body.tempK > 0 && <Row label="Температура" value={`${Math.round(body.tempK)} K`} />}
          {body.pressureAtm > 0 && <Row label="Давление" value={`${body.pressureAtm.toFixed(3)} атм`} />}
          {body.atmosphere && <Row label="Атмосфера" value={body.atmosphere} />}
          {body.volcanism && <Row label="Вулканизм" value={body.volcanism} />}
          {body.landable && <Row label="Посадка" value="🛬 возможна" />}
          {body.bioSignals > 0 && <Row label="Биосигналы" value={`🌿 ${body.bioSignals}`} />}
          {body.rings.length > 0 && <Row label="Кольца" value={body.rings.map((ring) => ring.ringClass || ring.name).join(', ')} />}
          {body.firstDiscoveredBy && <Row label="Открыл" value={`CMDR ${body.firstDiscoveredBy}`} />}
          {body.firstMappedBy && <Row label="Картировал" value={`CMDR ${body.firstMappedBy}`} />}
        </div>
      )}

      {structures.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#ff9f43', marginBottom: 6, fontWeight: 700 }}>
            🏗 Постройки на теле ({structures.length})
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {structures.map(({ structure, project }) => {
              const resources = project?.resources ?? [];
              return (
                <div key={structure.id} className="ed-map-card" data-target="1">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#eeeeee', fontWeight: 600 }}>{structure.name}</span>
                    <span style={{ fontSize: 11, color: structure.complete ? '#22c55e' : '#e67e22' }}>
                      {structure.complete ? 'готово' : `${structure.progress.toFixed(0)}%`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    {structure.type} · {structure.surface ? 'поверхность' : 'орбита'}
                  </div>
                  <div style={{ height: 4, background: '#3a3d40', borderRadius: 2, margin: '5px 0 3px', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, Math.max(0, structure.progress))}%`, height: '100%', background: structure.complete ? '#22c55e' : '#e67e22' }} />
                  </div>
                  {structure.requiredTons > 0 && (
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      {formatNumber(structure.providedTons)} / {formatNumber(structure.requiredTons)} т
                      {structure.requiredTons - structure.providedTons > 0 && (
                        <span style={{ color: '#e67e22' }}> · осталось {formatNumber(structure.requiredTons - structure.providedTons)} т</span>
                      )}
                    </div>
                  )}
                  {resources.length > 0 && (
                    <div style={{ marginTop: 5, display: 'grid', gap: 2 }}>
                      {resources.slice(0, 6).map((resource) => (
                        <div key={resource.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af' }}>
                          <span>{resource.name}</span>
                          <span style={{ color: '#e2e8f0' }}>
                            {typeof resource.provided === 'number' ? formatNumber(resource.provided) : '—'}
                            {' / '}
                            {typeof resource.required === 'number' ? formatNumber(resource.required) : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {neighbours.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#6b7280', marginBottom: 5 }}>Ближайшие тела</div>
          <div style={{ display: 'grid', gap: 3 }}>
            {neighbours.map((candidate) => (
              <button
                key={candidate.name}
                onClick={() => onPick(candidate.name, 2)}
                onDoubleClick={() => onPick(candidate.name, 3)}
                style={{ background: 'transparent', border: 'none', color: '#93c5fd', fontSize: 11, textAlign: 'left', cursor: 'pointer', padding: 0 }}
              >
                → {candidate.name}{candidate.bioSignals > 0 ? ` 🌿${candidate.bioSignals}` : ''}{candidate.landable ? ' 🛬' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span>{label}:</span>
      <span style={{ color: '#e2e8f0', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
