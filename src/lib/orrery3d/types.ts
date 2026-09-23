/**
 * Общий контракт данных карты системы («3D-оверей»).
 *
 * Один и тот же JSON описывает карту в двух местах:
 *
 * * сайт — `buildOrreryView()` собирает его из `OrreryLayout`
 *   (`src/lib/systemOrrery.ts`) и проектов Raven;
 * * Colonial Helper — `uploader/system_view.py` собирает его из `MapSnapshot`
 *   через `orrery.plan_system()`.
 *
 * Поэтому рендерер (`viewer.ts`) ничего не знает про источники данных: сайт и
 * десктоп рисуют одну и ту же сцену одним и тем же движком (three.js), а не
 * двумя разными (Plotly в браузере против Tk-холста в приложении).
 *
 * Версия в `version` — контракт между Python и JS. Меняя структуру, поднимайте
 * её: `uploader/system_view.py` кладёт такую же, и тесты сверяют их между собой.
 */

export const ORRERY_VIEW_VERSION = 3;

export type Vec3 = [number, number, number];

export type BodyKindView = 'star' | 'planet' | 'moon';

/** Кольцо планеты. */
export interface OrreryViewRing {
  name: string;
  ringClass: string;
  innerKm: number;
  outerKm: number;
}

/** Орбитальные элементы так, как их видит карта (единые имена для JS/Python). */
export interface OrreryViewElements {
  /** Эксцентриситет 0..1. */
  eccentricity: number;
  /** Наклонение к плоскости системы, градусы. */
  inclinationDeg: number;
  /** Аргумент перицентра, градусы. */
  periapsisDeg: number;
  /** Средняя аномалия на момент скана, градусы. */
  meanAnomalyDeg: number;
  /** Период обращения, земные сутки (0 — неизвестен). */
  periodDays: number;
  /** Наклон оси вращения, градусы (плоскость колец). */
  axialTiltDeg: number;
  /** true — хоть один элемент пришёл из журнала/EDSM, а не восстановлен. */
  real: boolean;
}

/** Положение тела относительно обитаемой зоны своей звезды. */
export type HabitableBand = 'inner' | 'habitable' | 'outer' | null;

/** Тело системы — и то, что нужно сцене, и то, что показывают карточки. */
export interface OrreryViewBody {
  name: string;
  /** Короткое имя без префикса системы («A 1» вместо «Sol A 1»). */
  shortName: string;
  kind: BodyKindView;
  /** Класс тела («Earthlike body», «Gas giant», «K») или пустая строка. */
  cls: string;
  /** Звезда-владелец (для планет и лун) — имя, пустая строка у одиночной. */
  star: string;
  /** Родительское тело (для луны — планета, для вторичной звезды — главная). */
  parent: string;
  position: Vec3;
  /** Радиус символической сферы в unit'ах сцены (по нему строятся постройки). */
  radius: number;
  /** Размер маркера на плоской схеме, px — совместимость с картой приложения. */
  marker: number;
  /** Настоящий радиус тела, метры. */
  radiusM: number;
  /** Ускорение свободного падения, м/с². */
  gravity: number;
  tempK: number;
  pressureAtm: number;
  /** Дистанция от точки входа в систему, световые секунды. */
  distanceLs: number;
  /** Большая полуось орбиты вокруг родителя, световые секунды. */
  orbitLs: number;
  atmosphere: string;
  volcanism: string;
  landable: boolean;
  bioSignals: number;
  /** Тело нанесено на карту (`SAASignalsFound`/картография). */
  mapped: boolean;
  /** Есть подробный скан. */
  scanned: boolean;
  rings: OrreryViewRing[];
  elements: OrreryViewElements;
  /** Кто открыл/нанёс на карту/первым ступил. */
  firstDiscoveredBy: string;
  firstMappedBy: string;
  firstFootfallBy: string;
  /** Цвет оболочки — считает payload (температура звезды/класс планеты). */
  color: string;
  /** Положение относительно обитаемой зоны звезды. */
  habitableBand: HabitableBand;
  /** Полуоси обитаемой зоны звезды в световых секундах (у планет — своей звезды). */
  habitableZoneLs: [number, number] | null;
  /** id построек на теле. */
  structures: string[];
}

/** Орбита: готовая полилиния в unit'ах сцены + метаданные для легенды и мотора. */
export interface OrreryViewOrbit {
  /** Имя тела, которое ходит по орбите. */
  name: string;
  /** Владелец орбиты: звезда-хозяин (у лун — планета-хозяин). */
  owner: string;
  kind: 'star' | 'planet' | 'moon';
  center: Vec3;
  /** Большая полуось в unit'ах сцены. */
  radius: number;
  eccentricity: number;
  /** true — эллипс построен по настоящим элементам. */
  real: boolean;
  periodDays: number;
  points: Vec3[];
}

/** Зона обитаемости звезды — кольцо в плоскости системы. */
export interface OrreryViewZone {
  owner: string;
  center: Vec3;
  /** Радиус внутренней и внешней границы зоны в unit'ах сцены. */
  inner: number;
  outer: number;
  innerLs: number;
  outerLs: number;
}

/** Постройка/станция на теле. */
export interface OrreryViewStructure {
  id: string;
  name: string;
  /** Тип («Planetary Outpost», «Coriolis Starport», …). */
  type: string;
  /** Тело-якорь (пустая строка — постройка висит без тела). */
  body: string;
  position: Vec3;
  /** Точка на поверхности тела (а не орбитальный маркер). */
  onSurface: boolean;
  /** 0..100. */
  progress: number;
  complete: boolean;
  requiredTons: number;
  providedTons: number;
  remainingTons: number;
  /** Ресурсы, если Raven/сайт их отдают: иначе пусто. */
  resources: { name: string; required: number; provided: number; remaining: number }[];
}

export interface OrreryViewCluster {
  star: string;
  center: Vec3;
  /** Сколько тел рисуется в кластере. */
  bodies: string[];
}

export interface OrreryViewSummary {
  stars: number;
  planets: number;
  moons: number;
  bodies: number;
  landable: number;
  bioBodies: number;
  bioSignals: number;
  ringed: number;
  structures: number;
  activeSites: number;
  completedSites: number;
  /** Тела без подробного скана. */
  unscanned: number;
}

/** Позиция пилота в системе (карта приложения отдаёт её журналом). */
export interface OrreryViewPlayer {
  name: string;
  position: Vec3;
  body: string;
  station: string;
}

/** Полный пакет для рендерера. */
export interface OrreryViewPayload {
  version: number;
  system: string;
  /** Полуразмер сцены в unit'ах: по нему считается камера обзора. */
  span: number;
  /** «linear» — линейный масштаб расстояний между звёздами, «orrery» — сжатый. */
  scaleMode: 'orrery' | 'linear';
  /** true — подписи тел можно показывать все, false — только у выбранных. */
  crowded: boolean;
  summary: OrreryViewSummary;
  clusters: OrreryViewCluster[];
  bodies: OrreryViewBody[];
  orbits: OrreryViewOrbit[];
  /** Орбиты лун — их можно гасить отдельным слоем. */
  moonOrbits: OrreryViewOrbit[];
  zones: OrreryViewZone[];
  structures: OrreryViewStructure[];
  player: OrreryViewPlayer | null;
  /** ISO-время сборки (для «данные от …» в интерфейсе). */
  generatedAt: string;
}

/** Пустой пакет: карта рисуется даже когда сканов нет — пустое небо и подсказка. */
export function emptyOrreryView(system = ''): OrreryViewPayload {
  return {
    version: ORRERY_VIEW_VERSION,
    system,
    span: 240,
    scaleMode: 'orrery',
    crowded: false,
    summary: {
      stars: 0, planets: 0, moons: 0, bodies: 0, landable: 0, bioBodies: 0,
      bioSignals: 0, ringed: 0, structures: 0, activeSites: 0, completedSites: 0, unscanned: 0,
    },
    clusters: [],
    bodies: [],
    orbits: [],
    moonOrbits: [],
    zones: [],
    structures: [],
    player: null,
    generatedAt: new Date().toISOString(),
  };
}
