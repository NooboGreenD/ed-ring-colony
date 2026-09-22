/**
 * Сборка пакета для 3D-карты системы из раскладки `lib/systemOrrery`.
 *
 * Раскладка отвечает на вопрос «где в сцене что стоит» (Кеплер, эллипсы,
 * сжатый масштаб, бюджеты кластеров). Пакет добавляет к этому то, что нужно
 * интерфейсу: цвета, факты для карточек, зоны обитаемости, постройки на
 * поверхности тел и сводку. Рендерер (`scene.ts`) читает только пакет, поэтому
 * тот же JSON собирает и Colonial Helper (`uploader/system_view.py`).
 */

import {
  bodyDisplayRadiusUnits,
  habitableZoneLs,
  placeStructures,
  starColorFromTemperature,
  type OrreryBody,
  type OrreryLayout,
  type OrreryStructure,
} from '@/lib/systemOrrery';
import { bodyColor, orbitColor, starColor, structureColor } from './palette';
import {
  ORRERY_VIEW_VERSION,
  type HabitableBand,
  type OrreryViewBody,
  type OrreryViewOrbit,
  type OrreryViewPayload,
  type OrreryViewStructure,
  type OrreryViewZone,
  type OrreryViewPlayer,
  type Vec3,
} from './types';

export interface BuildOrreryViewOptions {
  systemName?: string;
  scaleMode?: 'orrery' | 'linear';
  /** Сколько пикселей приходится на полный размах сцены — база размеров. */
  canvasPx?: number;
  player?: OrreryViewPlayer | null;
}

const LS_PER_AU = 499.00478;

function vec(point: readonly number[] | undefined | null): Vec3 {
  if (!point) return [0, 0, 0];
  return [
    Number(point[0]) || 0,
    Number(point[1]) || 0,
    Number(point[2]) || 0,
  ];
}

/** Положение тела относительно зоны обитаемости звезды. */
function habitableBandOf(orbitLs: number, zone: [number, number] | null): HabitableBand {
  if (!zone || orbitLs <= 0) return null;
  const [inner, outer] = zone;
  if (!(inner > 0) || !(outer > inner)) return null;
  if (orbitLs < inner) return 'inner';
  if (orbitLs > outer) return 'outer';
  return 'habitable';
}

/**
 * Собрать пакет для рендерера.
 *
 * `structures` — уже нормализованные постройки (`toStructures`), поэтому
 * функция не знает ни про Raven, ни про локальную БД.
 */
export function buildOrreryView(
  layout: OrreryLayout,
  structures: OrreryStructure[] = [],
  options: BuildOrreryViewOptions = {},
): OrreryViewPayload {
  const systemName = options.systemName ?? '';
  const canvasPx = options.canvasPx && options.canvasPx > 0 ? options.canvasPx : 1000;
  const halfSpan = Math.max(1, layout.span);

  // Зоны обитаемости: раскладка отдаёт только центральную окружность, а карте
  // нужна полоса «внутри/снаружи». Масштаб берём тот же, которым раскладка
  // перевела световые секунды в unit'ы сцены (локальный, вокруг середины зоны).
  const zoneByStar = new Map<string, OrreryViewZone>();
  const hzLsByStar = new Map<string, [number, number]>();
  for (const path of layout.hzPaths) {
    const star = layout.byName[path.owner];
    if (!star) continue;
    const zoneLs = habitableZoneLs(star);
    hzLsByStar.set(path.owner, zoneLs);
    const midLs = (zoneLs[0] + zoneLs[1]) / 2;
    const scale = midLs > 0 ? path.radius / midLs : 0;
    if (!(scale > 0)) continue;
    zoneByStar.set(path.owner, {
      owner: path.owner,
      center: vec(path.center),
      inner: zoneLs[0] * scale,
      outer: zoneLs[1] * scale,
      innerLs: zoneLs[0],
      outerLs: zoneLs[1],
    });
  }

  const sphereRadii: Record<string, number> = {};
  for (const body of layout.bodies) {
    if (body.kind === 'star') continue;
    sphereRadii[body.name] = bodyDisplayRadiusUnits(layout, body.name, halfSpan, canvasPx);
  }

  const placements = placeStructures(layout, structures, halfSpan, canvasPx, sphereRadii);
  const structuresByBody = new Map<string, OrreryViewStructure[]>();

  const viewStructures: OrreryViewStructure[] = placements.map((placement) => {
    const structure = placement.structure;
    const provided = structure.providedTons || 0;
    const required = structure.requiredTons || 0;
    const remaining = Math.max(0, required - provided);
    const view: OrreryViewStructure = {
      id: structure.id,
      name: structure.name,
      type: structure.type,
      body: placement.anchorName ?? '',
      position: vec(placement.position),
      onSurface: placement.onSurface,
      progress: Math.max(0, Math.min(100, structure.complete ? 100 : structure.progress || 0)),
      complete: Boolean(structure.complete),
      requiredTons: required,
      providedTons: provided,
      remainingTons: remaining,
      resources: (structure.resources ?? []).map((resource) => ({
        name: resource.name,
        required: resource.required || 0,
        provided: resource.provided || 0,
        remaining: Math.max(0, (resource.required || 0) - (resource.provided || 0)),
      })),
    };
    if (placement.anchorName) {
      const list = structuresByBody.get(placement.anchorName) ?? [];
      list.push(view);
      structuresByBody.set(placement.anchorName, list);
    }
    return view;
  });

  const starNames = new Set(layout.stars.map((star) => star.name));
  const clusterOfBody = new Map<string, string>();
  for (const cluster of layout.clusters) {
    for (const member of cluster.bodies) clusterOfBody.set(member.name, cluster.starName);
  }

  const bodies: OrreryViewBody[] = layout.bodies.map((body: OrreryBody) => {
    const position = vec(layout.positions[body.name]);
    const isStar = body.kind === 'star';
    const ownerStar = isStar
      ? body.name
      : (starNames.has(clusterOfBody.get(body.name) ?? '') ? clusterOfBody.get(body.name)! : '');
    const zoneLs = ownerStar ? hzLsByStar.get(ownerStar) ?? (isStar ? habitableZoneLs(body) : null) : null;
    const ownerBody = ownerStar ? layout.byName[ownerStar] : undefined;
    const zone: [number, number] | null = zoneLs ?? (ownerBody ? habitableZoneLs(ownerBody) : null);
    const orbitLs = body.orbitLs || body.distanceLs;
    return {
      name: body.name,
      shortName: systemName && body.name.toLowerCase().startsWith(systemName.trim().toLowerCase())
        ? (body.name.slice(systemName.trim().length).trim() || body.name)
        : body.name,
      kind: body.kind,
      cls: body.subType || '',
      star: ownerStar,
      parent: isStar ? (body.name === layout.stars[0]?.name ? '' : layout.stars[0]?.name ?? '') : (findParentName(layout, body) ?? ownerStar),
      position,
      radius: isStar ? 0 : sphereRadii[body.name] ?? 0.8,
      marker: layout.markerSizes[body.name] ?? 8,
      radiusM: body.radiusM,
      gravity: body.gravity,
      tempK: body.tempK,
      pressureAtm: body.pressureAtm,
      distanceLs: body.distanceLs,
      orbitLs,
      atmosphere: body.atmosphere,
      volcanism: body.volcanism,
      landable: body.landable,
      bioSignals: body.bioSignals,
      mapped: Boolean(body.raw && (body.raw.mapped || body.raw.was_mapped || body.raw.WasMapped)),
      scanned: Boolean(body.raw && (body.raw.scanned || body.raw.ScanType)),
      rings: body.rings.map((ring) => ({
        name: ring.name,
        ringClass: ring.ringClass,
        innerKm: ring.innerKm,
        outerKm: ring.outerKm,
      })),
      elements: {
        eccentricity: body.elements.eccentricity,
        inclinationDeg: body.elements.inclinationDeg,
        periapsisDeg: body.elements.periapsisDeg,
        meanAnomalyDeg: body.elements.meanAnomalyDeg,
        periodDays: body.elements.periodDays,
        axialTiltDeg: body.elements.axialTiltDeg,
        real: body.elements.fromData,
      },
      firstDiscoveredBy: body.firstDiscoveredBy,
      firstMappedBy: body.firstMappedBy,
      firstFootfallBy: body.firstFootfallBy,
      color: isStar
        ? starColor(body.subType, body.tempK, starColorFromTemperature)
        : bodyColor(body.subType, body.kind),
      habitableBand: habitableBandOf(orbitLs, zone),
      habitableZoneLs: zone,
      structures: (structuresByBody.get(body.name) ?? []).map((structure) => structure.id),
    };
  });

  const toOrbit = (path: OrreryLayout['orbits'][number]): OrreryViewOrbit => ({
    name: path.name ?? path.owner,
    owner: path.owner,
    kind: path.kind,
    center: vec(path.center),
    radius: path.radius,
    eccentricity: path.eccentricity ?? 0,
    real: Boolean(path.real),
    periodDays: path.periodDays ?? 0,
    points: (path.points ?? []).map((point) => vec(point)),
  });

  const orbits = layout.orbits
    .filter((path) => path.kind === 'star' || path.kind === 'planet')
    .map(toOrbit);
  const moonOrbits = layout.moonOrbits.map(toOrbit);

  const viewBodies = bodies.filter((body) => body.kind !== 'star');
  const summary = {
    stars: layout.stars.length,
    planets: viewBodies.filter((body) => body.kind === 'planet').length,
    moons: viewBodies.filter((body) => body.kind === 'moon').length,
    bodies: layout.bodies.length,
    landable: viewBodies.filter((body) => body.landable).length,
    bioBodies: viewBodies.filter((body) => body.bioSignals > 0).length,
    bioSignals: viewBodies.reduce((total, body) => total + body.bioSignals, 0),
    ringed: layout.bodies.filter((body) => body.rings.length > 0).length,
    structures: viewStructures.length,
    activeSites: viewStructures.filter((structure) => !structure.complete).length,
    completedSites: viewStructures.filter((structure) => structure.complete).length,
    unscanned: viewBodies.filter((body) => !body.scanned).length,
  };

  return {
    version: ORRERY_VIEW_VERSION,
    system: systemName,
    span: halfSpan,
    scaleMode: options.scaleMode ?? 'orrery',
    crowded: layout.labelMode === 'focused',
    summary,
    clusters: layout.clusters.map((cluster) => ({
      star: cluster.starName,
      center: vec(cluster.center),
      bodies: cluster.bodies.map((body) => body.name),
    })),
    bodies,
    orbits,
    moonOrbits,
    zones: [...zoneByStar.values()],
    structures: viewStructures,
    player: options.player ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/** Имя родительского тела по `parentIds`/префиксу имени (для карточек). */
function findParentName(layout: OrreryLayout, body: OrreryBody): string | null {
  const byId = new Map<number, OrreryBody>();
  for (const candidate of layout.bodies) {
    if (candidate.bodyId != null) byId.set(candidate.bodyId, candidate);
  }
  for (const parentId of body.parentIds) {
    const parent = byId.get(parentId);
    if (parent) return parent.name;
  }
  // Без id — по самому длинному префиксу имени, как в раскладке лун.
  let best: OrreryBody | null = null;
  for (const candidate of layout.bodies) {
    if (candidate.name === body.name) continue;
    if (!body.name.startsWith(candidate.name)) continue;
    if (!best || candidate.name.length > best.name.length) best = candidate;
  }
  return best?.name ?? null;
}

/** Сводка «сколько чего» для заголовка карты. */
export function describeView(payload: OrreryViewPayload): string[] {
  const parts: string[] = [];
  const { summary } = payload;
  parts.push(`★ ${summary.stars}`);
  parts.push(`планет ${summary.planets}`);
  if (summary.moons) parts.push(`лун ${summary.moons}`);
  if (summary.landable) parts.push(`посадка: ${summary.landable}`);
  if (summary.bioSignals) parts.push(`био ${summary.bioSignals}`);
  if (summary.ringed) parts.push(`кольца: ${summary.ringed}`);
  if (summary.structures) {
    parts.push(summary.activeSites ? `строек ${summary.activeSites}` : `строек ${summary.structures}`);
  }
  return parts;
}

/** «12 345,6 св. с» — короткая подпись дистанции для карточек. */
export function lsToAu(value: number): number {
  return value / LS_PER_AU;
}

/** Цвет маркера постройки — нужен и сцене, и спискам интерфейса. */
export function structureTint(structure: OrreryViewStructure): string {
  return structureColor(structure);
}

/** Цвет орбиты для легенды. */
export function orbitTint(orbit: OrreryViewOrbit): string {
  return orbitColor(orbit.kind, orbit.real);
}
