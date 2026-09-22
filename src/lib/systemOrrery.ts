/**
 * Планировщик 3D-оррери звездной системы.
 *
 * Модуль нарочно не зависит ни от React, ни от Plotly: вся геометрия считается
 * чистыми функциями, которые можно покрыть тестами (`scripts/tests`) и переис-
 * пользовать и в компоненте карты, и в экспортёрах.
 *
 * Задачи, которые здесь решаются (они же — правки из ТЗ):
 *
 * 1. **Многозвёздные системы.** Тела привязываются к своей звезде по цепочке
 *    `parents` (как в журнале/EDSM), а не «все планеты крутят орбиту вокруг
 *    главной». Каждая звезда получает свой кластер с собственным бюджетом
 *    радиуса, поэтому система из десятка-двух звёзд не превращается в кашу.
 * 2. **Фокус с приближением.** `computeFocusView` возвращает центр, разрез
 *    осей и дистанцию камеры — карта реально приближается к телу, а не слегка
 *    сдвигает камеру, как это было в старой версии.
 * 3. **Наземные постройки на поверхности.** Смещения строек/поселений считаются
 *    от визуального радиуса тела (`bodyDisplayRadiusUnits`), а не фиксированными
 *    «3.5 + idx*2.5» units — иначе постройка висела в космосе в паре единиц от
 *    планеты, что на масштабе системы выглядит как отдельный объект.
 */

export type BodyKind = 'star' | 'planet' | 'moon';

export interface OrreryRing {
  name: string;
  ringClass: string;
  innerKm: number;
  outerKm: number;
}

/**
 * Орбитальные элементы тела — то, что реально приходит из журнала
 * (`Scan`) или из EDSM (`raw_data`).
 *
 * Пока элементов нет, карта строила окружности с выдуманной фазой и
 * наклоном. Здесь все величины берутся из данных, а `fromData` честно
 * говорит, настоящая это орбита или восстановленная по умолчанию: UI
 * показывает это в подписи, а тесты различают два режима.
 */
export interface OrbitalElements {
  /** Большая полуось в световых секундах (0 — неизвестна). */
  semiMajorAxisLs: number;
  /** Эксцентриситет 0..1 (0 — окружность). */
  eccentricity: number;
  /** Наклонение орбиты к плоскости эклиптики системы, градусы. */
  inclinationDeg: number;
  /** Аргумент перицентра, градусы. */
  periapsisDeg: number;
  /** Период обращения, земные сутки. */
  periodDays: number;
  /** Средняя аномалия — положение тела на орбите, градусы. */
  meanAnomalyDeg: number;
  /** Наклон оси вращения, градусы (для плоскости колец). */
  axialTiltDeg: number;
  /** Есть ли в записи хоть один настоящий элемент. */
  fromData: boolean;
}

/** Элементы по умолчанию: круговая орбита в плоскости системы. */
export const DEFAULT_ELEMENTS: OrbitalElements = {
  semiMajorAxisLs: 0,
  eccentricity: 0,
  inclinationDeg: 0,
  periapsisDeg: 0,
  periodDays: 0,
  meanAnomalyDeg: 0,
  axialTiltDeg: 0,
  fromData: false,
};

export interface OrreryBody {
  name: string;
  kind: BodyKind;
  bodyId: number | null;
  subType: string;
  /** Distance from the system arrival point, in light seconds. */
  distanceLs: number;
  /** Semi-major axis around its own parent (planet for moons), LS. */
  orbitLs: number;
  /** Настоящие орбитальные элементы (из `raw_data`/журнала), если есть. */
  elements: OrbitalElements;
  parentIds: number[];
  /** Name of the star this body belongs to ('' when unknown/single-star). */
  starKey: string;
  radiusM: number;
  /** Surface gravity in m/s^2 (journal unit). */
  gravity: number;
  tempK: number;
  pressureAtm: number;
  landable: boolean;
  bioSignals: number;
  atmosphere: string;
  volcanism: string;
  rings: OrreryRing[];
  firstDiscoveredBy: string;
  firstMappedBy: string;
  firstFootfallBy: string;
  raw: Record<string, unknown>;
}

export interface OrreryStructure {
  id: string;
  name: string;
  type: string;
  bodyName: string;
  progress: number;
  complete: boolean;
  requiredTons: number;
  providedTons: number;
  surface: boolean;
  resources: { name: string; required: number; provided: number }[];
}

export interface OrreryOrbitPath {
  name: string;
  owner: string;
  kind: 'planet' | 'moon' | 'star';
  points: [number, number, number][];
  center: [number, number, number];
  radius: number;
  /** True, когда орбита построена по настоящим элементам из данных. */
  real?: boolean;
  /** Эксцентриситет (0 — окружность): нужен подписям и тестам. */
  eccentricity?: number;
  /** Период обращения в земных сутках, если известен. */
  periodDays?: number;
}

export interface OrreryCluster {
  starName: string;
  star: OrreryBody | null;
  center: [number, number, number];
  /** Half-extent of the cluster in scene units — planets never grow past it. */
  budget: number;
  bodies: OrreryBody[];
  /** Index of the star, 0 = primary. */
  index: number;
}

export interface OrreryLayout {
  bodies: OrreryBody[];
  byName: Record<string, OrreryBody>;
  stars: OrreryBody[];
  clusters: OrreryCluster[];
  positions: Record<string, [number, number, number]>;
  markerSizes: Record<string, number>;
  orbits: OrreryOrbitPath[];
  moonOrbits: OrreryOrbitPath[];
  ringPaths: OrreryOrbitPath[];
  hzPaths: OrreryOrbitPath[];
  /** Half-extent of the whole scene in scene units (axis range when unfocused). */
  span: number;
  labelMode: 'all' | 'focused' | 'none';
  starCount: number;
  bodyCount: number;
}

export interface StructurePlacement {
  structure: OrreryStructure;
  /** Anchor body (null → the structure floats on a marker at the system centre). */
  anchorName: string | null;
  position: [number, number, number];
  /** True when the marker sits on the body's visual limb/surface. */
  onSurface: boolean;
}

const GOLDEN_ANGLE = 2.399963229728653;
const LS_PER_AU = 499.00478;
const SOL_RADIUS_M = 6.957e8;
const SOL_TEMP_K = 5778;

/** Half-extent of the unfocused scene, in scene units. */
export const SCENE_SPAN = 240;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/**
 * Нормализовать запись тела: строка `system_scans`, «сырой» записи EDSM или
 * записи, пришедшие из Raven. Всё сводится к одному плоскому виду.
 */
export function normalizeBody(record: Record<string, unknown>, systemName = ''): OrreryBody {
  const type = str(record.body_type ?? record.type ?? record.bodyType);
  const subType = str(record.sub_type ?? record.subType ?? record.planet_class ?? record.star_type);
  const name = str(record.body_name ?? record.name ?? record.bodyName) || (systemName ? `${systemName} Body` : 'Неизвестное тело');
  const combined = `${type} ${subType}`.toLowerCase();
  // Планетные слова перевешивают буквенный признак: раньше регулярка по
  // спектральному классу ловила «Gas giant» (G) и «T Tauri»-подобные названия,
  // из-за чего газовые гиганты рисовались звёздами.
  const planetish = /planet|moon|giant|world|body|belt|cluster|asteroid|comet|husk/.test(combined);
  const isStar = combined.includes('star') || combined.includes('звезд')
    || (!planetish && /^(?:[obafgkm]\d?|[lty]\d?|tts|aebe|w[nco]?|c[s jnh]?|chd?|ms|d[a-z]{0,3}|neutron|black\s?hole|supermassiveblackhole|n|h|s)(?=\s|\(|$)/i.test(subType));
  const rawParents = Array.isArray(record.parents) ? record.parents : [];
  const parentIds: number[] = [];
  let hasPlanetParent = false;
  for (const entry of rawParents) {
    if (!entry || typeof entry !== 'object') continue;
    const record0 = entry as Record<string, unknown>;
    const planet = record0.Planet ?? record0.planet;
    const star = record0.Star ?? record0.star;
    const local = record0.Local ?? record0.local;
    if (planet != null) hasPlanetParent = true;
    for (const candidate of [planet, star, local]) {
      const value = Number(candidate);
      if (Number.isSafeInteger(value) && value > 0 && !parentIds.includes(value)) parentIds.push(value);
    }
  }
  const kind: BodyKind = isStar ? 'star' : hasPlanetParent || combined.includes('moon') ? 'moon' : 'planet';
  const ringsRaw = Array.isArray(record.rings) ? record.rings : [];
  const rings: OrreryRing[] = [];
  for (const ring of ringsRaw) {
    if (!ring || typeof ring !== 'object') continue;
    const ringRecord = ring as Record<string, unknown>;
    rings.push({
      name: str(ringRecord.name ?? ringRecord.RingName) || 'Кольцо',
      ringClass: str(ringRecord.ringClass ?? ringRecord.RingClass ?? ringRecord.sub_type ?? ringRecord.type) || 'Icy',
      innerKm: num(ringRecord.innerRadiusKm ?? ringRecord.inner_km ?? ringRecord.InnerRad) / (ringRecord.InnerRad != null ? 1000 : 1),
      outerKm: num(ringRecord.outerRadiusKm ?? ringRecord.outer_km ?? ringRecord.OuterRad) / (ringRecord.OuterRad != null ? 1000 : 1),
    });
  }
  const distanceLs = num(record.distance_ls ?? record.distanceLs ?? record.distanceToArrival ?? record.distance);

  return {
    name,
    kind,
    bodyId: Number.isSafeInteger(num(record.body_id ?? record.bodyId)) && num(record.body_id ?? record.bodyId) > 0
      ? num(record.body_id ?? record.bodyId)
      : null,
    subType: subType || type,
    distanceLs,
    orbitLs: Math.max(0, num(record.semi_major_axis_ls ?? record.orbit_ls ?? num(record.semiMajorAxisLy) * LS_PER_AU, distanceLs)),
    // Настоящие орбитальные элементы лежат в `raw_data` (журнал/EDSM): без
    // них карта строила бы окружности с выдуманной фазой и наклоном.
    elements: parseOrbitalElements(record),
    parentIds,
    starKey: extractStarKey(name, systemName),
    radiusM: num(record.radius_m ?? record.radiusM ?? record.radius),
    gravity: num(record.gravity),
    tempK: num(record.surface_temp_k ?? record.surfaceTemperature ?? record.temp_k),
    pressureAtm: num(record.surface_pressure) / 101_325,
    landable: Boolean(record.is_landable ?? record.landable ?? record.isLandable),
    bioSignals: num(record.bio_signals_count ?? record.bio_signals ?? record.bioSignalsCount),
    atmosphere: str(record.atmosphere ?? record.atmosphere_type ?? record.atmosphereType),
    volcanism: str(record.volcanism ?? record.volcanismType),
    rings,
    firstDiscoveredBy: str(record.first_discovered_by ?? record.firstDiscoveredBy),
    firstMappedBy: str(record.first_mapped_by ?? record.firstMappedBy),
    firstFootfallBy: str(record.first_footfall_by ?? record.firstFootfallBy),
    raw: record,
  };
}

/**
 * Буквенное обозначение звезды в имени тела: «Sol A 3» → «A»,
 * «Shinrarta Dezhra AB 5» → «AB», «Sol 16» → ''.
 */
export function extractStarKey(bodyName: string, systemName = ''): string {
  let rest = bodyName.trim();
  if (systemName && rest.toLowerCase().startsWith(systemName.trim().toLowerCase())) {
    rest = rest.slice(systemName.trim().length);
  }
  const match = rest.match(/^\s*([A-Z]{1,3})(?=\s|$)/);
  if (!match) return '';
  // «Barnard 5 B 1» — одиночная буква после номера тела не обозначение звезды
  // системы, а компонент; считаем звездой только префикс сразу за именем.
  return /^[A-Z]{1,3}$/.test(match[1]) ? match[1] : '';
}

/** Оценить светимость звезды (в L☉) по радиусу и температуре. */
export function estimateStarLuminosity(body: OrreryBody): number {
  const radiusSol = body.radiusM > 0 ? body.radiusM / SOL_RADIUS_M : 1;
  const tempSol = body.tempK > 0 ? body.tempK / SOL_TEMP_K : 1;
  return Math.max(1e-4, radiusSol * radiusSol * tempSol * tempSol * tempSol * tempSol);
}

/** Границы обитаемой зоны в св. секундах (0.75–1.77 а.е. × √L). */
export function habitableZoneLs(body: OrreryBody): [number, number] {
  const sqrtL = Math.sqrt(estimateStarLuminosity(body));
  const inner = 0.75 * sqrtL * LS_PER_AU;
  const outer = Math.max(inner + 5, 1.77 * sqrtL * LS_PER_AU);
  return [inner, outer];
}

function logMap(value: number, min: number, max: number): number {
  const low = Math.log10(Math.max(1e-3, min));
  const high = Math.log10(Math.max(1e-3, max));
  if (high - low < 1e-6) return 0.5;
  return Math.min(1, Math.max(0, (Math.log10(Math.max(1e-3, value)) - low) / (high - low)));
}

/**
 * Приблизительный привязанный к звезде обход: у каждого тела ищем звезду —
 * предка в цепочке `parents`; при нехватке id — по буквенному ключу имени.
 */
function resolveStarOwner(body: OrreryBody, byId: Map<number, OrreryBody>, stars: OrreryBody[]): OrreryBody | null {
  if (body.kind === 'star') return body;
  let current: OrreryBody | null = body;
  const guard = new Set<string>();
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (guard.has(current.name)) break;
    guard.add(current.name);
    if (current.kind === 'star') return current;
    const parentId: number | undefined = current.parentIds.find((id) => byId.has(id) && !guard.has(byId.get(id)!.name));
    if (parentId == null) break;
    current = byId.get(parentId) ?? null;
  }
  if (stars.length <= 1) return stars[0] ?? null;
  const key = body.starKey;
  if (key) {
    const byKey = stars.find((star) => star.starKey === key || star.name.endsWith(` ${key}`));
    if (byKey) return byKey;
  }
  // «Sol 5» в системе с кучей звёзд и без parents: берем ближайшую звезду по
  // дистанции — хуже «всех в один кластер» точно не будет.
  let nearest: OrreryBody | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const star of stars) {
    const delta = Math.abs(star.distanceLs - body.distanceLs);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = star;
    }
  }
  return nearest ?? stars[0] ?? null;
}

/** Визуальный размер маркера тела в px (логарифм по радиусу, с потолком). */
export function bodyMarkerSize(body: OrreryBody, crowded: boolean): number {
  const radiusKm = Math.max(50, body.radiusM / 1000);
  const base = body.kind === 'star'
    ? 13 + Math.log10(Math.max(1000, radiusKm) / 1e5) * 4
    : 5.5 + Math.log10(radiusKm / 1000) * 3.2;
  const floor = crowded ? 4 : 5.5;
  const ceiling = crowded ? 13 : body.kind === 'star' ? 26 : 18;
  return Math.round(Math.min(ceiling, Math.max(floor, base)) * 10) / 10;
}

export interface LayoutOptions {
  /** 'orrery' — лог-сжатие орбит; 'linear' — честный масштаб св. секунд. */
  scaleMode?: 'orrery' | 'linear';
  showMoons?: boolean;
  /** Внешние станции/стройки — нужны для решения, сколько подписей рисовать. */
  structureCount?: number;
}

/**
 * Главный расчёт: координаты звёзд, планет, лун, орбит, колец и обитаемых зон.
 */
export function buildOrreryLayout(
  records: Record<string, unknown>[] | null | undefined,
  systemName = '',
  options: LayoutOptions = {},
): OrreryLayout {
  const scaleMode = options.scaleMode ?? 'orrery';
  const showMoons = options.showMoons ?? true;
  // Функция обязана быть тотальной: карта вызывается на данных из API и журнала,
  // где `bodies` спокойно может прийти null. Исключение здесь = пустая страница
  // с «Application error» у клиента, а не деградация вида.
  const bodies = (records ?? [])
    .filter((record) => record && typeof record === 'object')
    .map((record) => normalizeBody(record, systemName));

  const byName: Record<string, OrreryBody> = {};
  const byId = new Map<number, OrreryBody>();
  for (const body of bodies) {
    byName[body.name] = body;
    if (body.bodyId != null && !byId.has(body.bodyId)) byId.set(body.bodyId, body);
  }

  const stars = bodies
    .filter((body) => body.kind === 'star')
    .sort((left, right) => left.distanceLs - right.distanceLs || left.name.localeCompare(right.name));
  const planets = bodies.filter((body) => body.kind === 'planet');
  const moons = bodies.filter((body) => body.kind === 'moon');
  const crowded = bodies.length > 28 || (options.structureCount ?? 0) > 6;

  const positions: Record<string, [number, number, number]> = {};
  const markerSizes: Record<string, number> = {};
  const orbits: OrreryOrbitPath[] = [];
  const moonOrbits: OrreryOrbitPath[] = [];
  const ringPaths: OrreryOrbitPath[] = [];
  const hzPaths: OrreryOrbitPath[] = [];
  const clusters: OrreryCluster[] = [];

  const primary = stars[0] ?? null;
  for (const body of bodies) markerSizes[body.name] = bodyMarkerSize(body, crowded);

  // Тела по кластерам своей звезды.
  const clusterOf = new Map<string, OrreryBody[]>();
  for (const body of [...planets, ...(showMoons ? moons : [])]) {
    const owner = resolveStarOwner(body, byId, stars);
    const key = owner?.name ?? '__none__';
    const list = clusterOf.get(key) ?? [];
    list.push(body);
    clusterOf.set(key, list);
    body.starKey = owner && owner !== body ? owner.name : body.starKey;
  }

  const starCount = Math.max(1, stars.length);
  // Бюджет главного кластера урезается по мере роста числа звёзд: в системе с
  // 30 звёздами_planеты каждой обязаны остаться читаемыми.
  const primaryBudget = SCENE_SPAN * (starCount === 1 ? 1 : Math.max(0.34, 0.86 / Math.sqrt(starCount)));
  const starSpread = SCENE_SPAN;

  const secondaryStars = stars.slice(1);
  const starRadii: Record<string, number> = {};
  if (secondaryStars.length > 0) {
    const distances = secondaryStars.map((star) => Math.max(1, star.distanceLs));
    const minDistance = Math.min(...distances);
    const maxDistance = Math.max(...distances);
    const minStep = Math.max(8, (starSpread - primaryBudget * 0.6) / (secondaryStars.length + 1));
    let cursor = primaryBudget * 0.6 + 10;
    secondaryStars.forEach((star, index) => {
      const distance = Math.max(1, star.distanceLs);
      const target = scaleMode === 'linear'
        ? cursor + (distance / Math.max(1, maxDistance)) * (starSpread - cursor)
        : primaryBudget * 0.6 + logMap(distance, minDistance, maxDistance) * (starSpread - primaryBudget * 0.6);
      const radius = Math.max(cursor, target, primaryBudget * 0.6 + 12 + index * minStep * 0.15);
      starRadii[star.name] = radius;
      cursor = radius + minStep * 0.5;
    });
  }

  const starCenter: Record<string, [number, number, number]> = {};
  if (primary) {
    positions[primary.name] = [0, 0, 0];
    starCenter[primary.name] = [0, 0, 0];
  } else {
    positions['__center__'] = [0, 0, 0];
    starCenter['__none__'] = [0, 0, 0];
  }

  secondaryStars.forEach((star, index) => {
    const radius = starRadii[star.name] ?? SCENE_SPAN * 0.8;
    const elements = star.elements;
    let center: [number, number, number];
    let orbit: [number, number, number][];
    let semiMajor = radius;

    if (elements.fromData) {
      // Компонент пары тоже ходит по эллипсу с главной звездой в фокусе.
      // Распределённый радиус трактуем как апоцентр: вытянутая орбита не
      // вылезет за габарит сцены.
      semiMajor = radius / (1 + elements.eccentricity);
      const oriented = {
        eccentricity: elements.eccentricity,
        inclination: (elements.inclinationDeg * Math.PI) / 180,
        periapsis: (elements.periapsisDeg * Math.PI) / 180,
      };
      center = orbitPoint(
        semiMajor,
        trueAnomaly((elements.meanAnomalyDeg * Math.PI) / 180, elements.eccentricity),
        oriented,
        [0, 0, 0],
      );
      orbit = orbitalPath(semiMajor, oriented, [0, 0, 0], 72);
    } else {
      const angle = index * GOLDEN_ANGLE;
      const inclination = (((-1) ** index) * (4 + (index * 7) % 12) * Math.PI) / 180;
      center = [
        radius * Math.cos(angle),
        radius * Math.sin(angle) * Math.cos(inclination),
        radius * Math.sin(angle) * Math.sin(inclination),
      ];
      orbit = ellipsePath(radius, center, 0, inclination, 48);
    }

    positions[star.name] = center;
    starCenter[star.name] = center;
    // Орбита второй звезды вокруг главной — по ней видно реальную ширину пары.
    orbits.push({
      name: star.name, owner: star.name, kind: 'star', points: orbit, center: [0, 0, 0], radius: semiMajor,
      real: elements.fromData, eccentricity: elements.eccentricity,
    });
  });

  const allStars: OrreryBody[] = primary ? [primary, ...secondaryStars] : secondaryStars;
  for (const star of allStars) {
    const center = starCenter[star.name] ?? [0, 0, 0];
    const isPrimary = primary?.name === star.name;
    const ownBudget = isPrimary
      ? primaryBudget
      : Math.max(14, Math.min(SCENE_SPAN * 0.3, (starRadii[star.name] ?? SCENE_SPAN) * 0.34));
    const members = (clusterOf.get(star.name) ?? []).slice();
    const planetsOnly = members.filter((body) => body.kind === 'planet');
    planetsOnly.sort((left, right) => left.orbitLs - right.orbitLs || left.name.localeCompare(right.name));

    const radii = distributeRadii(planetsOnly, ownBudget, scaleMode);
    planetsOnly.forEach((body, index) => {
      const radius = radii[index] ?? ownBudget * 0.5;
      const elements = body.elements;
      let point: [number, number, number];
      let orbit: [number, number, number][];
      let semiMajor = radius;
      // Плоскость колец — плоскость экватора тела, поэтому наклон колец
      // берём из осевого наклона, а не из наклона орбиты.
      let ringInclination: number;

      if (elements.fromData) {
        // Настоящая орбита: эллипс с звездой в фокусе, наклон и аргумент
        // перицентра из данных, положение тела — по средней аномалии.
        // `radius` трактуем как апоцентр: орбита гарантированно остаётся
        // в бюджете кластера и порядок тел по дистанции сохраняется.
        semiMajor = radius / (1 + elements.eccentricity);
        const oriented = {
          eccentricity: elements.eccentricity,
          inclination: (elements.inclinationDeg * Math.PI) / 180,
          periapsis: (elements.periapsisDeg * Math.PI) / 180,
        };
        point = orbitPoint(
          semiMajor,
          trueAnomaly((elements.meanAnomalyDeg * Math.PI) / 180, elements.eccentricity),
          oriented,
          center,
        );
        orbit = orbitalPath(semiMajor, oriented, center, crowded ? 64 : 96);
        ringInclination = ((elements.axialTiltDeg || elements.inclinationDeg) * Math.PI) / 180;
      } else {
        const angle = (index * GOLDEN_ANGLE) % (Math.PI * 2);
        const inclinationDeg = (((-1) ** index) * (2.5 + ((index * 5) % 9)));
        const inclination = (inclinationDeg * Math.PI) / 180;
        point = [
          center[0] + radius * Math.cos(angle),
          center[1] + radius * Math.sin(angle) * Math.cos(inclination),
          center[2] + radius * Math.sin(angle) * Math.sin(inclination),
        ];
        orbit = ellipsePath(radius, center, 0, inclination, crowded ? 48 : 72);
        ringInclination = inclination;
      }

      positions[body.name] = point;
      orbits.push({
        name: body.name,
        owner: star.name,
        kind: 'planet',
        center,
        radius: semiMajor,
        points: orbit,
        real: elements.fromData,
        eccentricity: elements.eccentricity,
        periodDays: elements.periodDays,
      });
      if (body.rings.length > 0) {
        const ringBase = ringDisplayRadius(markerSizes[body.name] ?? 8, ownBudget);
        body.rings.forEach((ring, ringIndex) => {
          ringPaths.push({
            name: `${body.name} · ${ring.name}`,
            owner: body.name,
            kind: 'planet',
            center: point,
            radius: ringBase + ringIndex * 2.4,
            points: ellipsePath(ringBase + ringIndex * 2.4, point, 0, ringInclination, 40),
          });
        });
      }
    });

    // Луны — вокруг своей планеты, в пределах 22% бюджета кластера.
    const memberMoons = members.filter((body) => body.kind === 'moon');
    const grouped = new Map<string, OrreryBody[]>();
    for (const moon of memberMoons) {
      const parentId = moon.parentIds.find((id) => byId.has(id) && byId.get(id)!.kind === 'planet');
      const parent = parentId != null ? byId.get(parentId)! : findNameParent(moon, planetsOnly);
      const key = parent?.name ?? '__orphan__';
      const list = grouped.get(key) ?? [];
      list.push(moon);
      grouped.set(key, list);
    }
    for (const [parentName, list] of grouped) {
      const parentPoint = positions[parentName] ?? center;
      const parentBody = byName[parentName];
      const parentSize = parentBody ? markerSizes[parentBody.name] ?? 6 : 6;
      const baseRadius = Math.max(3.2, parentSize * 0.55);
      list.sort((left, right) => left.orbitLs - right.orbitLs || left.name.localeCompare(right.name));
      list.forEach((moon, index) => {
        const radius = baseRadius + 1.8 + index * Math.max(1.6, baseRadius * 0.45);
        const elements = moon.elements;
        let point: [number, number, number];
        let orbit: [number, number, number][];
        let semiMajor = radius;

        if (elements.fromData) {
          // У лун элементы тоже есть в журнале: рисуем настоящий эллипс
          // с планетой в фокусе, а не окружность с выдуманной фазой.
          semiMajor = radius / (1 + elements.eccentricity);
          const oriented = {
            eccentricity: elements.eccentricity,
            inclination: (elements.inclinationDeg * Math.PI) / 180,
            periapsis: (elements.periapsisDeg * Math.PI) / 180,
          };
          point = orbitPoint(
            semiMajor,
            trueAnomaly((elements.meanAnomalyDeg * Math.PI) / 180, elements.eccentricity),
            oriented,
            parentPoint,
          );
          orbit = orbitalPath(semiMajor, oriented, parentPoint, 40);
        } else {
          const angle = (index * 2.1 + 0.6) % (Math.PI * 2);
          const inclination = (((-1) ** index) * 4 * Math.PI) / 180;
          point = [
            parentPoint[0] + radius * Math.cos(angle),
            parentPoint[1] + radius * Math.sin(angle) * Math.cos(inclination),
            parentPoint[2] + radius * Math.sin(angle) * Math.sin(inclination),
          ];
          orbit = ellipsePath(radius, parentPoint, 0, inclination, 32);
        }

        positions[moon.name] = point;
        if (showMoons) {
          moonOrbits.push({
            name: moon.name,
            owner: parentName,
            kind: 'moon',
            center: parentPoint,
            radius: semiMajor,
            points: orbit,
            real: elements.fromData,
            eccentricity: elements.eccentricity,
            periodDays: elements.periodDays,
          });
        }
      });
    }

    // Обитаемая зона — своя у каждой звезды (L по радиусу и температуре).
    const zone = habitableZoneLs(star);
    const mapped = mapLsToUnits(zone[0], zone[1], planetsOnly, radii, ownBudget, scaleMode);
    if (mapped > 0) {
      hzPaths.push({
        name: star.name,
        owner: star.name,
        kind: 'star',
        center,
        radius: mapped,
        points: ellipsePath(mapped, center, 0, 0, 64),
      });
    }

    clusters.push({
      starName: star.name,
      star,
      center,
      budget: ownBudget,
      bodies: [...planetsOnly, ...(showMoons ? memberMoons : [])],
      index: stars.findIndex((candidate) => candidate.name === star.name),
    });
  }

  if (stars.length === 0) {
    // Системы без звезды в данных не редкость (только FSS-скан планет).
    const orbiters = planets.slice().sort((left, right) => left.orbitLs - right.orbitLs);
    const radii = distributeRadii(orbiters, SCENE_SPAN, scaleMode);
    orbiters.forEach((body, index) => {
      const radius = radii[index] ?? SCENE_SPAN * 0.5;
      const angle = (index * GOLDEN_ANGLE) % (Math.PI * 2);
      const point: [number, number, number] = [radius * Math.cos(angle), radius * Math.sin(angle), 0];
      positions[body.name] = point;
      orbits.push({ name: body.name, owner: '', kind: 'planet', center: [0, 0, 0], radius, points: ellipsePath(radius, [0, 0, 0], 0, 0, 64) });
    });
    clusters.push({ starName: '', star: null, center: [0, 0, 0], budget: SCENE_SPAN, bodies: orbiters, index: 0 });
  }

  return {
    bodies,
    byName,
    stars,
    clusters,
    positions,
    markerSizes,
    orbits,
    moonOrbits,
    ringPaths,
    hzPaths,
    span: SCENE_SPAN,
    labelMode: crowded ? 'focused' : 'all',
    starCount: stars.length,
    bodyCount: bodies.length,
  };
}

function findNameParent(moon: OrreryBody, planets: OrreryBody[]): OrreryBody | null {
  let best: OrreryBody | null = null;
  for (const planet of planets) {
    if (moon.name.startsWith(planet.name) && (!best || planet.name.length > best.name.length)) best = planet;
  }
  return best;
}

/** Лог-раскладка орбит внутри бюджета кластера с гарантированным шагом. */
function distributeRadii(bodies: OrreryBody[], budget: number, scaleMode: string): number[] {
  if (bodies.length === 0) return [];
  const inner = Math.min(10, budget * 0.18);
  const outer = budget;
  if (bodies.length === 1) return [(inner + outer) / 2];
  const distances = bodies.map((body) => Math.max(0.1, body.orbitLs || body.distanceLs));
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  const minStep = Math.max(2.2, (outer - inner) / (bodies.length * 1.9));
  const radii: number[] = [];
  let cursor = inner;
  bodies.forEach((body, index) => {
    const distance = Math.max(0.1, body.orbitLs || body.distanceLs);
    const fraction = scaleMode === 'linear'
      ? (distance - min) / Math.max(1e-6, max - min)
      : logMap(distance, min, max);
    const target = Math.max(cursor, inner + fraction * (outer - inner));
    radii.push(target);
    cursor = target + minStep;
  });
  const overflow = radii[radii.length - 1] - outer;
  if (overflow > 0) {
    // Жёсткий потолок бюджета: иначе соседний кластер начнёт перекрываться.
    const squeeze = (outer - inner) / (radii[radii.length - 1] - inner || 1);
    return radii.map((radius) => inner + (radius - inner) * Math.min(1, squeeze));
  }
  return radii;
}

function mapLsToUnits(innerLs: number, outerLs: number, bodies: OrreryBody[], radii: number[], budget: number, scaleMode: string): number {
  if (bodies.length === 0 || radii.length === 0) return 0;
  const mid = (innerLs + outerLs) / 2;
  const distances = bodies.map((body) => Math.max(0.1, body.orbitLs || body.distanceLs));
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  if (mid >= max) return budget;
  if (mid <= min) return radii[0] * 0.8;
  const fraction = scaleMode === 'linear'
    ? (mid - min) / Math.max(1e-6, max - min)
    : logMap(mid, min, max);
  const index = Math.min(radii.length - 1, Math.round(fraction * (radii.length - 1)));
  return radii[index];
}

/** Эллиптическая (наклонённая) окружность в мировых координатах. */
export function ellipsePath(
  radius: number,
  center: [number, number, number],
  phase: number,
  inclination: number,
  steps: number,
): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    const phi = phase + (Math.PI * 2 * step) / steps;
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    points.push([center[0] + x, center[1] + y * Math.cos(inclination), center[2] + y * Math.sin(inclination)]);
  }
  return points;
}

/* ── Настоящая орбитальная механика ─────────────────────────────────── */

const TWO_PI = Math.PI * 2;
const METERS_PER_LIGHT_SECOND = 299_792_458;
const SECONDS_PER_DAY = 86_400;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Разобрать орбитальные элементы из записи тела.
 *
 * Источники и ЕДИНИЦЫ (проверено по живым данным, а не по догадке):
 *
 * • строка `system_scans` — только `semi_major_axis_ls` (св. секунды);
 *   остальное лежит в `raw_data` — полном JSON из журнала или EDSM.
 *
 * • `raw_data` из журнала Elite Dangerous (событие `Scan`) — имена в
 *   PascalCase: `Eccentricity`, `OrbitalInclination` (°), `Periapsis` (°),
 *   `OrbitalPeriod` (СЕКУНДЫ), `MeanAnomaly` (°), `AxialTilt` (°),
 *   `SemiMajorAxis` (МЕТРЫ).
 *
 * • `raw_data` из EDSM (`/api-system-v1/bodies`) — имена в camelCase и
 *   другие единицы: `orbitalEccentricity`, `orbitalInclination` (°),
 *   `argOfPeriapsis` (°), `orbitalPeriod` (СУТКИ), `axialTilt` (°),
 *   `semiMajorAxis` (АСТРОНОМИЧЕСКИЕ ЕДИНИЦЫ). Средней аномалии EDSM не
 *   отдаёт вовсе — фаза берётся только из журнала.
 *
 * Период и полуось различаем ПО ИМЕНИ ПОЛЯ, а не по величине: планета с
 * периодом 300 лет (> 1e5 суток) в EDSM иначе превратилась бы в секунды.
 *
 * Всё, чего в данных нет, остаётся нулём, а `fromData` говорит, можно ли
 * считать орбиту настоящей.
 */
export function parseOrbitalElements(record: Record<string, unknown>): OrbitalElements {
  const raw = record?.raw_data;
  const source: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};

  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (record?.[key] != null) return record[key];
      if (source[key] != null) return source[key];
    }
    return undefined;
  };

  // `Number(null) === 0`, поэтому отсутствующее поле нельзя гнать через
  // обычный `num`: иначе «нет данных» превращается в ноль, `fromData`
  // становится истинной всегда, и карта рисует выдуманный эллипс как
  // настоящий. Только явное число считается значением.
  const opt = (...keys: string[]): number => {
    const value = pick(...keys);
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  };

  // Полуось: журнал — метры (`SemiMajorAxis`), EDSM — астрономические
  // единицы (`semiMajorAxis`), БД — уже световые секунды.
  const semiMajorM = opt('semi_major_axis_m', 'SemiMajorAxis');
  const semiMajorAu = opt('semiMajorAxis');
  const semiMajorLs = Number.isFinite(semiMajorM) && semiMajorM > 0
    ? semiMajorM / METERS_PER_LIGHT_SECOND
    : Number.isFinite(semiMajorAu) && semiMajorAu > 0
      ? semiMajorAu * LS_PER_AU
      : opt('semi_major_axis_ls');

  const eccentricity = clamp(opt('orbitalEccentricity', 'eccentricity', 'Eccentricity'), 0, 0.98);
  const inclinationDeg = opt('orbitalInclination', 'orbital_inclination', 'OrbitalInclination', 'inclination');
  const periapsisDeg = opt('argOfPeriapsis', 'periapsis', 'Periapsis');
  // Период: EDSM — сутки, журнал — секунды. Решает имя поля, а не величина:
  // планета с периодом в 300 лет (> 1e5 суток) иначе стала бы «секундами».
  const periodDaysFromEdsm = opt('orbitalPeriod', 'orbital_period_days');
  const periodSecondsFromJournal = opt('OrbitalPeriod', 'orbital_period_s');
  const periodDays = Number.isFinite(periodDaysFromEdsm)
    ? periodDaysFromEdsm
    : Number.isFinite(periodSecondsFromJournal)
      ? periodSecondsFromJournal / SECONDS_PER_DAY
      : NaN;
  // Среднюю аномалию отдаёт только журнал: в EDSM такого поля нет.
  const meanAnomalyDeg = opt('MeanAnomaly', 'mean_anomaly');
  const axialTiltDeg = opt('axialTilt', 'axial_tilt', 'AxialTilt');

  const fromData = [eccentricity, inclinationDeg, periapsisDeg, periodDays, meanAnomalyDeg]
    .some((value) => Number.isFinite(value));

  return {
    semiMajorAxisLs: Number.isFinite(semiMajorLs) ? Math.max(0, semiMajorLs) : 0,
    eccentricity: Number.isFinite(eccentricity) ? eccentricity : 0,
    inclinationDeg: Number.isFinite(inclinationDeg) ? inclinationDeg : 0,
    periapsisDeg: Number.isFinite(periapsisDeg) ? periapsisDeg : 0,
    periodDays: Number.isFinite(periodDays) ? Math.max(0, periodDays) : 0,
    meanAnomalyDeg: Number.isFinite(meanAnomalyDeg) ? meanAnomalyDeg : 0,
    axialTiltDeg: Number.isFinite(axialTiltDeg) ? axialTiltDeg : 0,
    fromData,
  };
}

/**
 * Решить уравнение Кеплера `M = E − e·sin E` относительно эксцентрической
 * аномалии E (метод Ньютона, 6 итераций сходятся при e < 0.98).
 */
export function solveKepler(meanAnomalyRad: number, eccentricity: number): number {
  const e = clamp(eccentricity, 0, 0.98);
  const M = ((meanAnomalyRad % TWO_PI) + TWO_PI) % TWO_PI;
  if (e < 1e-6) return M;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i += 1) {
    const delta = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < 1e-9) break;
  }
  return E;
}

/** Истинная аномалия (угол от перицентра) из средней. */
export function trueAnomaly(meanAnomalyRad: number, eccentricity: number): number {
  const e = clamp(eccentricity, 0, 0.98);
  const E = solveKepler(meanAnomalyRad, e);
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
}

export interface OrbitOrientation {
  /** Наклонение плоскости орбиты, радианы. */
  inclination: number;
  /** Аргумент перицентра, радианы (поворот в плоскости орбиты). */
  periapsis: number;
}

/**
 * Точка эллипса в мировых координатах.
 *
 * Звезда/планета-родитель находится в ФОКУСЕ эллипса, а не в его центре —
 * именно это делает картинку похожей на настоящую систему: вытянутые орбиты
 * комет и внешних тел больше не выглядят окружностями.
 *
 * @param semiMajorUnits большая полуось в единицах сцены
 * @param trueAnomalyRad истинная аномалия
 * @param elements эксцентриситет и ориентация
 * @param center мировые координаты фокуса (звезды)
 */
export function orbitPoint(
  semiMajorUnits: number,
  trueAnomalyRad: number,
  elements: Pick<OrbitalElements, 'eccentricity'> & OrbitOrientation,
  center: [number, number, number],
): [number, number, number] {
  const e = clamp(elements.eccentricity, 0, 0.98);
  const a = Math.max(0, semiMajorUnits);
  // Радиус-вектор в фокальной форме: r = a(1−e²)/(1+e·cos ν).
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(trueAnomalyRad));
  const angle = trueAnomalyRad + elements.periapsis;
  const x = r * Math.cos(angle);
  const y = r * Math.sin(angle);
  return [
    center[0] + x,
    center[1] + y * Math.cos(elements.inclination),
    center[2] + y * Math.sin(elements.inclination),
  ];
}

/**
 * Полная орбита по настоящим элементам: эллипс со звездой в фокусе,
 * наклонённый и повёрнутый так, как в данных системы.
 */
export function orbitalPath(
  semiMajorUnits: number,
  elements: Pick<OrbitalElements, 'eccentricity'> & OrbitOrientation,
  center: [number, number, number],
  steps = 96,
): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    points.push(orbitPoint(semiMajorUnits, (TWO_PI * step) / steps, elements, center));
  }
  return points;
}

/**
 * Где тело находится на своей орбите прямо сейчас (по средней аномалии из
 * данных). Если аномалии нет, позиция детерминированно выводится из индекса,
 * чтобы карта не «прыгала» между загрузками.
 */
export function orbitalPosition(
  semiMajorUnits: number,
  elements: OrbitalElements,
  center: [number, number, number],
  fallbackAngle = 0,
): [number, number, number] {
  const meanAnomaly = elements.meanAnomalyDeg !== 0 || elements.fromData
    ? (elements.meanAnomalyDeg * Math.PI) / 180
    : fallbackAngle;
  return orbitPoint(semiMajorUnits, trueAnomaly(meanAnomaly, elements.eccentricity), {
    eccentricity: elements.eccentricity,
    inclination: (elements.inclinationDeg * Math.PI) / 180,
    periapsis: (elements.periapsisDeg * Math.PI) / 180,
  }, center);
}

/** Ориентация орбиты из элементов тела. */
export function orientationOf(elements: OrbitalElements): OrbitOrientation {
  return {
    inclination: (elements.inclinationDeg * Math.PI) / 180,
    periapsis: (elements.periapsisDeg * Math.PI) / 180,
  };
}

/**
 * Реалистичный радиус звезды в единицах сцены — по её настоящему радиусу
 * относительно Солнца. Раньше все звёзды рисовались маркером одного порядка,
 * и красный карлик выглядел как сверхгигант.
 */
export function starRadiusScale(body: Pick<OrreryBody, 'radiusM' | 'subType'>): number {
  const radiusSol = body.radiusM > 0 ? body.radiusM / SOL_RADIUS_M : 0;
  if (!(radiusSol > 0)) return 1;
  // Логарифм: сверхгиганты в 1000 R☉ не должны съедать всю сцену.
  return clamp(0.7 + Math.log10(radiusSol) * 0.55, 0.45, 2.6);
}

/**
 * Цвет звезды по температуре — приближение излучения абсолютно чёрного тела
 * (кубический сплайн по контрольным точкам 1 000–40 000 K), а не по букве
 * спектрального класса: класс мы знаем не всегда, а температуру даёт и
 * журнал, и EDSM.
 */
export function starColorFromTemperature(tempK: number): string | null {
  if (!(tempK > 0)) return null;
  const stops: [number, [number, number, number]][] = [
    [1000, [255, 122, 54]],
    [2000, [255, 138, 12]],
    [3000, [255, 180, 107]],
    [4000, [255, 209, 163]],
    [5000, [255, 228, 206]],
    [5778, [255, 244, 234]],
    [6600, [255, 255, 255]],
    [7500, [214, 229, 255]],
    [10000, [178, 205, 255]],
    [20000, [155, 176, 255]],
    [40000, [140, 155, 255]],
  ];
  const t = clamp(tempK, stops[0][0], stops[stops.length - 1][0]);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [lowTemp, lowRgb] = stops[i];
    const [highTemp, highRgb] = stops[i + 1];
    if (t >= lowTemp && t <= highTemp) {
      const k = (t - lowTemp) / (highTemp - lowTemp || 1);
      const rgb = lowRgb.map((channel, index) => Math.round(channel + (highRgb[index] - channel) * k));
      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
  }
  return null;
}

/**
 * Сколько scene-units занимает один пиксель при данном разрезе осей.
 *
 * Нужен, чтобы «посадить» наземную постройку ровно на визуальный limb планеты:
 * Plotly рисует маркеры в пикселях, а координаты — в unit'ах сцены, и без
 * пересчёта смещение в 4 unit'а на обзоре системы = «в космосе», а в фокусе
 * на теле — «внутри кратера».
 */
export function unitsPerPixel(axisSpan: number, canvasPixels: number): number {
  if (!(canvasPixels > 0) || !(axisSpan > 0)) return 1;
  return axisSpan / canvasPixels;
}

/** Визуальный радиус тела в unit'ах сцены (половина маркера + запас). */
export function bodyDisplayRadiusUnits(
  layout: OrreryLayout,
  bodyName: string,
  axisHalfSpan: number,
  canvasPixels: number,
): number {
  const sizePx = layout.markerSizes[bodyName] ?? 8;
  const ratio = unitsPerPixel(axisHalfSpan * 2, canvasPixels);
  return Math.max(0.6, (sizePx / 2) * ratio * 1.25);
}

function ringDisplayRadius(markerPx: number, budget: number): number {
  return Math.min(budget * 0.18, Math.max(2.6, markerPx * 0.42));
}

/** Найти тело по «свободному» имени (Raven присылает «HD 183092 B 5» без системы). */
function matchBodyByName(layout: OrreryLayout, name: string): string | null {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  if (!target) return null;
  if (layout.positions[target]) return target;
  const exact = Object.keys(layout.positions).find((key) => key.toLowerCase() === target);
  if (exact) return exact;
  const contained = Object.keys(layout.positions)
    .filter((key) => {
      const lower = key.toLowerCase();
      return lower.endsWith(target) || target.endsWith(lower) || lower.includes(target) || target.includes(lower);
    })
    .sort((left, right) => left.length - right.length);
  return contained[0] ?? null;
}

/**
 * Развесить постройки по телу.
 *
 * Два режима:
 *
 * • `overview` (общий обзор системы) — маркер ставится ровно на тело, чуть
 *   приподнятым над «limb», чтобы его было видно: прежнее фиксированное
 *   смещение в 3–10 unit'ов выглядело как «посылка висит в пустоте».
 * • `surface` (фокус на теле, `sphereRadii` задан) — постройки ложатся на
 *   поверхность нарисованной сферы_planеты по золотой спирали, т.е. буквально
 *   «на поверхности», а не на орбите.
 */
export function placeStructures(
  layout: OrreryLayout,
  structures: OrreryStructure[],
  axisHalfSpan: number,
  canvasPixels: number,
  sphereRadii: Record<string, number> = {},
): StructurePlacement[] {
  const grouped = new Map<string, OrreryStructure[]>();
  const orphans: OrreryStructure[] = [];
  for (const structure of structures) {
    const anchor = structure.bodyName && layout.positions[structure.bodyName]
      ? structure.bodyName
      : matchBodyByName(layout, structure.bodyName);
    if (!anchor) {
      orphans.push(structure);
      continue;
    }
    const list = grouped.get(anchor) ?? [];
    list.push(structure);
    grouped.set(anchor, list);
  }

  const placed: StructurePlacement[] = [];
  for (const [bodyName, list] of grouped) {
    const body = layout.byName[bodyName];
    const center = layout.positions[bodyName] ?? [0, 0, 0];
    const surface = Boolean(body) && body!.kind !== 'star';
    const sphere = sphereRadii[bodyName];
    list.forEach((structure, index) => {
      if (sphere && sphere > 0) {
        const point = onSphere(center, sphere * SPHERE_SURFACE_LIFT, index, list.length);
        placed.push({ structure, anchorName: bodyName, onSurface: surface, position: point });
        return;
      }
      const lift = bodyDisplayRadiusUnits(layout, bodyName, axisHalfSpan, canvasPixels) + 0.35;
      const angle = list.length === 1 ? Math.PI / 2 : Math.PI / 2 + (Math.PI * 2 * index) / list.length;
      placed.push({
        structure,
        anchorName: bodyName,
        onSurface: surface,
        position: [
          center[0] + lift * Math.cos(angle) * 0.35,
          center[1] + lift * Math.sin(angle) * 0.35,
          center[2] + lift,
        ],
      });
    });
  }

  orphans.forEach((structure, index) => {
    // Постройка без известной планеты: кладём на «орбиту» вокруг центра системы,
    // но рядом с маркером, а не в случайной точке пространства.
    const angle = index * GOLDEN_ANGLE;
    const radius = 16 + index * 4;
    placed.push({
      structure,
      anchorName: null,
      onSurface: false,
      position: [radius * Math.cos(angle), radius * Math.sin(angle), 2],
    });
  });

  return placed;
}

/** Точка на сфере вокруг `center` (золотая спираль — точки не слипаются). */
export function onSphere(
  center: [number, number, number],
  radius: number,
  index: number,
  total: number,
): [number, number, number] {
  const count = Math.max(1, total);
  const y = count === 1 ? 0.45 : 1 - (2 * (index + 0.5)) / count;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = (index + 1) * GOLDEN_ANGLE;
  return [
    center[0] + radius * ringRadius * Math.cos(theta),
    center[1] + radius * ringRadius * Math.sin(theta),
    center[2] + radius * y,
  ];
}

/**
 * Радиус «символической» сферы тела в unit'ах сцены при фокусе.
 *
 * Реальный радиус планеты в масштабах системы невидим (Земля на орбите 500 св.
 * с — это 0.00004 от радиуса обзора), поэтому планета рисуется преувеличенной
 * сферой во столько-то раз уже половины разреза осей: 0.42 — «тело крупно»,
 * 0.12 — «окрестности тела».
 */
export function bodySphereRadiusUnits(halfSpan: number, fraction: number): number {
  return Math.max(0.5, halfSpan * fraction);
}

/** UV-сфера для mesh3d: координаты вершин и индексы треугольников. */
export interface SphereGeometry {
  x: number[];
  y: number[];
  z: number[];
  i: number[];
  j: number[];
  k: number[];
}

/**
 * Материал и сетка сферы тела в режимах «окрестность»/«поверхность».
 * Числа общие с `uploader/orrery.py` (SPHERE_MESH / SPHERE_MATERIAL), чтобы
 * карта приложения и карта сайта показывали одно и то же тело.
 */
export const SPHERE_MESH: [number, number] = [40, 24];
export const SPHERE_HAZE_SCALE = 1.06;
/** На сколько «приподнять» постройку над поверхностью сферы (то же число в JS экспорта). */
export const SPHERE_SURFACE_LIFT = 1.03;
export const SPHERE_MATERIAL = {
  // Непрозрачная сфера: через прозрачную было видно обратные грани, и тело
  // выглядело блином, а не шаром.
  opacity: 1,
  flatshading: false,
  lighting: { ambient: 0.3, diffuse: 0.85, specular: 0.4, roughness: 0.6, fresnel: 0.55 },
  // Косой источник: без него при ортографической проекции шар вылизан в пятно.
  lightposition: { x: -1.2, y: 1, z: 1.4 },
};

/**
 * Кубический бокс сцены. `aspectmode: 'data'` берёт пропорции из габарита
 * данных: у системы, чьи орбиты лежат почти в одной плоскости, сцена сплющивается
 * в блин — вместе с ней и планеты. Поэтому бокс задаём вручную (1:1:1), а
 * единство масштаба держит кубический разрез осей.
 */
export function sceneAspect(): { aspectmode: 'manual'; aspectratio: { x: number; y: number; z: number } } {
  return { aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: 1 } };
}

export function sphereGeometry(
  center: [number, number, number],
  radius: number,
  segments = 20,
  rings = 12,
): SphereGeometry {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (Math.PI * ring) / rings;
    for (let segment = 0; segment <= segments; segment += 1) {
      const theta = (Math.PI * 2 * segment) / segments;
      x.push(center[0] + radius * Math.sin(phi) * Math.cos(theta));
      y.push(center[1] + radius * Math.sin(phi) * Math.sin(theta));
      z.push(center[2] + radius * Math.cos(phi));
    }
  }
  const i: number[] = [];
  const j: number[] = [];
  const k: number[] = [];
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const first = ring * stride + segment;
      const second = first + stride;
      i.push(first, second);
      j.push(second, first + 1);
      k.push(first + 1, second + 1);
    }
  }
  return { x, y, z, i, j, k };
}

export interface FocusView {
  target: string;
  center: [number, number, number];
  halfSpan: number;
  eyeDistance: number;
  clusterName: string | null;
}

/**
 * Камера и разрез осей для фокуса на теле.
 *
 * `zoom` 0 — общий обзор; 1 — кластер звезды; 2 — окрестность тела;
 * 3 — крупно само тело (видно, что постройки стоят на поверхности).
 */
/** Направление взгляда камеры Plotly: (0.62, −0.62, 0.4), нормализованное до |eye| = 1.35. */
const CAMERA_DIR: Record<'iso' | 'top' | 'side', [number, number, number]> = {
  iso: [0.62, -0.62, 0.4],
  top: [0.001, 0.001, 1],
  side: [1, 0.001, 0.06],
};

/** Расстояние камеры до цели в нормализованных единицах сцены (1 = половина разреза). */
export const CAMERA_DISTANCE = 1.35;

export type SceneCamera = {
  eye: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  projection: { type: 'orthographic' };
};

/**
 * Камера сцены. Два правила, без которых 3D ломается:
 *
 * 1. `center` — всегда ноль. Plotly берёт его в нормализованных единицах сцены
 *    (1 = половина разреза окна), а не в unit'ах системы. Координата цели
 *    (например 110.6) уводила камеру в космос: «при фокусе чёрный экран».
 *    Центр окна задаётся размахом осей — он и так стоит на цели.
 * 2. Проекция ортографическая, а |eye| больше 1. Перспектива + короткий глаз
 *    = часть системы обрезана краем рамки, а на «поверхности» камера
 *    оказывалась внутри сферы тела.
 *
 * Приближение делает размах осей (`computeFocusView`), поэтому расстояние
 * камеры одинаково для всех уровней зума.
 */
export function sceneCamera(view: 'iso' | 'top' | 'side' = 'iso'): SceneCamera {
  const dir = CAMERA_DIR[view] ?? CAMERA_DIR.iso;
  const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const k = CAMERA_DISTANCE / norm;
  return {
    eye: { x: dir[0] * k, y: dir[1] * k, z: dir[2] * k },
    up: view === 'top' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
    center: { x: 0, y: 0, z: 0 },
    projection: { type: 'orthographic' },
  };
}

/**
 * Запас окна. `FOCUS_PAD` — чтобы сфера тела и постройки на ней не липли к
 * краю рамки, `OVERVIEW_PAD` — чтобы орбиты, кольца и зоны обитаемости не
 * обрезались краем поля. Зеркало `orrery.FOCUS_PAD` / `orrery.OVERVIEW_PAD`.
 */
export const FOCUS_PAD = 1.02;
export const OVERVIEW_PAD = 1.04;

/** Максимальный |координаты| по собранным трассам — габарит того, что видно. */
export function traceExtent(traces: Iterable<Record<string, unknown>>): number {
  let extent = 0;
  for (const trace of traces) {
    if (!trace) continue;
    for (const key of ['x', 'y', 'z']) {
      const values = (trace as Record<string, unknown>)[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) extent = Math.max(extent, Math.abs(value));
      }
    }
  }
  return extent;
}

/** Разрез окна фокуса с запасом — то же число, что в `orrery.focus_window`. */
export function focusWindow(halfSpan: number): number {
  return Math.max(halfSpan, 1e-3) * FOCUS_PAD;
}

/** Кубический разрез обзора: габарит всех точек и не меньше бюджета системы. */
export function overviewWindow(extent: number, minimum = 0): number {
  return Math.max(Math.max(extent, minimum) * OVERVIEW_PAD, 1);
}

export function computeFocusView(
  layout: OrreryLayout,
  target: string,
  zoom: 0 | 1 | 2 | 3,
  canvasPixels = 900,
): FocusView | null {
  const position = layout.positions[target];
  if (!position) return null;
  const cluster = layout.clusters.find((candidate) =>
    candidate.starName === target || candidate.bodies.some((body) => body.name === target),
  ) ?? null;
  const body = layout.byName[target];
  const sizeUnits = bodyDisplayRadiusUnits(layout, target, layout.span, canvasPixels);

  if (zoom === 0) {
    return { target, center: [0, 0, 0], halfSpan: layout.span, eyeDistance: 1.65, clusterName: cluster?.starName ?? null };
  }
  if (zoom === 1) {
    const center = cluster?.center ?? [0, 0, 0];
    // Реальный габарит кластера (а не «весь потолок бюджета»): так переход
    // «система → кластер» действительно приближает карту, а не просто смещает центр.
    let extent = 0;
    for (const member of cluster?.bodies ?? []) {
      const point = layout.positions[member.name];
      if (!point) continue;
      extent = Math.max(extent, Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]));
    }
    const ownStarDistance = Math.hypot(center[0], center[1], center[2]);
    const halfSpan = Math.max(
      Math.min(layout.span * 0.94, extent * 1.08 + 4),
      sizeUnits * 6,
      ownStarDistance > 0 ? sizeUnits * 6 : 0,
    );
    return { target, center, halfSpan, eyeDistance: 1.2, clusterName: cluster?.starName ?? null };
  }
  if (zoom === 2) {
    const neighborDistance = nearestNeighbourDistance(layout, target);
    const halfSpan = Math.max(sizeUnits * 5, Math.min(layout.span * 0.35, neighborDistance * 1.35));
    return { target, center: position, halfSpan, eyeDistance: 0.9, clusterName: cluster?.starName ?? null };
  }
  return {
    target,
    center: position,
    halfSpan: Math.max(sizeUnits * 1.9, 3.2),
    eyeDistance: 0.72,
    clusterName: cluster?.starName ?? null,
  };
}

function nearestNeighbourDistance(layout: OrreryLayout, target: string): number {
  const point = layout.positions[target];
  if (!point) return layout.span;
  let best = Number.POSITIVE_INFINITY;
  for (const [name, other] of Object.entries(layout.positions)) {
    if (name === target) continue;
    const distance = Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]);
    if (distance > 0.0001 && distance < best) best = distance;
  }
  return Number.isFinite(best) ? best : layout.span * 0.2;
}

/** Соседние тела той же системы — для панели «рядом» (звёзды: у них свой выбор). */
export function neighboursOf(layout: OrreryLayout, target: string, limit = 4): OrreryBody[] {
  const point = layout.positions[target];
  if (!point) return [];
  const stars = new Set(layout.stars.map((star) => star.name));
  return layout.bodies
    .filter((body) => body.name !== target && !stars.has(body.name) && layout.positions[body.name])
    .map((body) => {
      const other = layout.positions[body.name];
      return { body, distance: Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
    .map((entry) => entry.body);
}

/** Сводка по системе для заголовка и «карточек»: звёзды, тела, постройки. */
export interface OrrerySummary {
  stars: number;
  planets: number;
  moons: number;
  landable: number;
  bioBodies: number;
  bioSignals: number;
  ringedBodies: number;
  structures: number;
  activeSites: number;
}

export function summarizeLayout(layout: OrreryLayout, structures: OrreryStructure[] = []): OrrerySummary {
  return {
    stars: layout.stars.length,
    planets: layout.bodies.filter((body) => body.kind === 'planet').length,
    moons: layout.bodies.filter((body) => body.kind === 'moon').length,
    landable: layout.bodies.filter((body) => body.landable).length,
    bioBodies: layout.bodies.filter((body) => body.bioSignals > 0).length,
    bioSignals: layout.bodies.reduce((total, body) => total + body.bioSignals, 0),
    ringedBodies: layout.bodies.filter((body) => body.rings.length > 0).length,
    structures: structures.length,
    activeSites: structures.filter((structure) => !structure.complete).length,
  };
}

/**
 * Нормализовать проекты Raven/сайта в постройки карты.
 *
 * `surface` — «наземные» постройки: у колонизационных объектов это всё, что
 * привязано к планете/луне (поселение, порт, аванпост). Всё, что висит у звезды
 * или без тела, остаётся орбитальным маркером.
 */
export function toStructures(projects: any[]): OrreryStructure[] {
  return (projects ?? []).map((project, index) => ({
    id: str(project.buildId) || `site-${index}`,
    name: str(project.buildName) || `Стройплощадка ${index + 1}`,
    type: str(project.buildType) || 'Постройка',
    bodyName: str(project.bodyName ?? project.body_name),
    progress: num(project.progress),
    complete: Boolean(project.complete) || num(project.progress) >= 100,
    requiredTons: num(project.totalRequired),
    providedTons: num(project.totalProvided),
    surface: true,
    resources: Array.isArray(project.resources)
      ? project.resources.map((resource: any) => ({
        name: str(resource.name ?? resource.nameLocalised),
        required: num(resource.required),
        provided: num(resource.provided),
      }))
      : [],
  }));
}
