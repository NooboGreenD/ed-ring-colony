/**
 * Сцена 3D-карты системы на three.js.
 *
 * Здесь нет ни рендерера, ни DOM: функция `buildOrreryScene()` собирает дерево
 * объектов и возвращает его вместе с индексами для наведения. Поэтому сцену
 * можно собрать и «пощупать» (raycast, координаты, слои) без WebGL — это и
 * делают тесты. Приложение Colonial Helper повторяет слои и порядок отрисовки
 * на холсте Tk (`uploader/tk_orrery.py`).
 *
 * Система координат пакета — как в журнале Elite: Z вверх. three.js работает с
 * Y вверх, поэтому корневая группа повёрнута на −90° вокруг X, а все размеры
 * остаются в «unit'ах сцены» (span ≈ 240).
 */

import * as THREE from 'three';
import { SIGNAL_META, activeSignalKinds } from '@/lib/bodySignals';
import { RING_CLASS_COLORS, SCENE_COLORS, ringColor, structureColor } from './palette';
import type { OrreryViewBody, OrreryViewPayload, OrreryViewStructure, Vec3 } from './types';

export type LayerName =
  | 'grid'
  | 'orbits'
  | 'moonOrbits'
  | 'zones'
  | 'rings'
  | 'structures'
  | 'moons'
  | 'signals'
  | 'player';

export const DEFAULT_LAYERS: Record<LayerName, boolean> = {
  grid: true,
  orbits: true,
  moonOrbits: true,
  zones: true,
  rings: true,
  structures: true,
  moons: true,
  signals: true,
  player: true,
};

export interface OrrerySceneModel {
  root: THREE.Group;
  /** Объекты, которые ловят курсор: у каждого в `userData` лежит `pick`. */
  pickables: THREE.Object3D[];
  groups: Record<'grid' | 'orbits' | 'moonOrbits' | 'zones' | 'stars' | 'planets' | 'moons' | 'rings' | 'structures' | 'signals' | 'player', THREE.Group>;
  /** Точка, к которой цепляется подпись тела. */
  labelAnchors: Map<string, THREE.Object3D>;
  /** Точка подписи постройки (верх маркера). */
  structureAnchors: Map<string, THREE.Object3D>;
  /** Меши тел: имя → объект (для подсветки и подписи). */
  bodyObjects: Map<string, THREE.Object3D>;
  /** Меши построек: id → объект. */
  structureObjects: Map<string, THREE.Object3D>;
  setLayer: (layer: LayerName, visible: boolean) => void;
  /** Подсветить выбранное тело: чужие орбиты и тела притухают. */
  setEmphasis: (name: string | null) => void;
  /**
   * Пульсация меток сигналов: вызывается каждый кадр с временем в секундах.
   * Именно она делает «эффект» заметным — статичную точку у планеты глаз
   * теряет, а мигающую находит сразу.
   */
  pulse: (timeSeconds: number) => void;
  dispose: () => void;
}

/** Один пульсирующий объект слоя сигналов. */
interface SignalPulse {
  object: THREE.Object3D;
  material: THREE.MeshBasicMaterial;
  baseScale: number;
  baseOpacity: number;
  phase: number;
}

export interface PickInfo {
  kind: 'body' | 'structure';
  name: string;
  body?: string;
}

const BASE_ORBIT_OPACITY = 0.55;
const DIM_ORBIT_OPACITY = 0.12;
const BASE_BODY_OPACITY = 1;
const DIM_BODY_OPACITY = 0.3;

interface BuildOptions {
  /** Слои, которые нужно выключить сразу. */
  hiddenLayers?: LayerName[];
}

/** Диапазон допустимых радиусов: сцена не должна превращаться в точки/шары. */
function clampRadius(value: number, span: number): number {
  return Math.min(Math.max(value, span * 0.002), span * 0.35);
}

function toVector(point: Vec3): THREE.Vector3 {
  return new THREE.Vector3(point[0], point[1], point[2]);
}

/**
 * Текстура свечения звезды. В jsdom (тесты) нет 2D-контекста canvas, поэтому
 * отсутствие текстуры — нормальная деградация: звезда остаётся без гало.
 */
function createGlowTexture(): THREE.Texture | null {
  const size = 128;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.25, 'rgba(255,236,190,0.55)');
    gradient.addColorStop(0.6, 'rgba(255,190,110,0.16)');
    gradient.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch {
    return null;
  }
}

/** Радиус тела в unit'ах сцены: минимум, чтобы планета была видна и в обзоре. */
function bodyRadius(body: OrreryViewBody, span: number): number {
  const base = body.radius > 0 ? body.radius : Math.max(0.6, body.marker * 0.06);
  return clampRadius(base, span);
}

/** Кольца планеты: пропорции берём из настоящих километров, но не буквально. */
function addRings(
  parent: THREE.Group,
  body: OrreryViewBody,
  radius: number,
  registry: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] },
): void {
  if (!body.rings.length) return;
  body.rings.forEach((ring, index) => {
    const realOuter = ring.outerKm > 0 ? ring.outerKm : 0;
    const realInner = ring.innerKm > 0 ? ring.innerKm : 0;
    const ratioInner = realInner > 0 && realOuter > realInner ? realInner / realOuter : 0.62;
    const outer = radius * (2.1 + index * 0.85);
    const inner = Math.max(radius * 1.35, outer * Math.min(0.94, Math.max(0.35, ratioInner)));
    const geometry = new THREE.RingGeometry(inner, outer, 96, 1);
    const color = new THREE.Color(ringColor(ring.ringClass) ?? RING_CLASS_COLORS.default);
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Кольца живут в отдельном слое (их гасят вместе с «кольцами»), поэтому
    // позицию тела задаём здесь: слой — мировая система координат.
    mesh.position.copy(toVector(body.position));
    // Плоскость колец — экватор тела: наклоняем по наклону оси.
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.y = THREE.MathUtils.degToRad(body.elements.axialTiltDeg || 0);
    mesh.userData.pick = { kind: 'body', name: body.name } satisfies PickInfo;
    registry.geometries.push(geometry);
    registry.materials.push(material);
    parent.add(mesh);
  });
}

function addAtmosphereHaze(
  parent: THREE.Group,
  body: OrreryViewBody,
  radius: number,
  color: string,
  registry: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] },
): void {
  const hasAtmosphere = Boolean(body.atmosphere) || body.pressureAtm > 0.001;
  if (!hasAtmosphere) return;
  const geometry = new THREE.SphereGeometry(radius * 1.06, 32, 20);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.14,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.pick = { kind: 'body', name: body.name } satisfies PickInfo;
  registry.geometries.push(geometry);
  registry.materials.push(material);
  parent.add(mesh);
}

/**
 * Метки сигналов у тела: аура + «маячки» по числу видов сигналов.
 *
 * Игра сообщает, что на теле есть биология, геология, следы людей, стражи
 * или таргоиды, — для архитектора это прямая подсказка, где садиться и что
 * рядом со стройкой уже есть. На карте вид сигнала различается цветом
 * (`SIGNAL_META`), количество — числом маячков, а пульсация делает метку
 * заметной среди десятков тел.
 */
function addSignalMarkers(
  parent: THREE.Group,
  body: OrreryViewBody,
  radius: number,
  registry: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] },
  pulses: SignalPulse[],
): void {
  const kinds = activeSignalKinds(body.signals);
  if (!kinds.length) return;

  const group = new THREE.Group();
  group.position.copy(toVector(body.position));
  group.name = `signals-${body.name}`;

  // Аура тела в цвете самого важного сигнала: видна даже на обзоре системы.
  const auraColor = new THREE.Color(SIGNAL_META[kinds[0]].color);
  const auraGeometry = new THREE.SphereGeometry(radius * 1.45, 24, 16);
  const auraMaterial = new THREE.MeshBasicMaterial({
    color: auraColor,
    transparent: true,
    opacity: 0.16,
    side: THREE.BackSide,
    depthWrite: false,
  });
  registry.geometries.push(auraGeometry);
  registry.materials.push(auraMaterial);
  const aura = new THREE.Mesh(auraGeometry, auraMaterial);
  aura.userData.pick = { kind: 'body', name: body.name } satisfies PickInfo;
  group.add(aura);
  pulses.push({ object: aura, material: auraMaterial, baseScale: 1, baseOpacity: 0.16, phase: 0 });

  // Маячки: по одному на вид сигнала, вокруг тела в плоскости системы.
  const markerSize = Math.max(radius * 0.26, 0.22);
  kinds.forEach((kind, index) => {
    const angle = (index / Math.max(1, kinds.length)) * Math.PI * 2;
    const distance = radius * 1.9 + markerSize * 2;
    const geometry = new THREE.IcosahedronGeometry(markerSize, 0);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SIGNAL_META[kind].color),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    registry.geometries.push(geometry);
    registry.materials.push(material);
    const marker = new THREE.Mesh(geometry, material);
    marker.position.set(Math.cos(angle) * distance, Math.sin(angle) * distance, radius * 0.4);
    // Наведение на маячок показывает карточку тела: отдельной сущности
    // «сигнал» в интерфейсе нет, есть тело с сигналами.
    marker.userData.pick = { kind: 'body', name: body.name } satisfies PickInfo;
    marker.userData.signal = kind;
    group.add(marker);
    pulses.push({ object: marker, material, baseScale: 1, baseOpacity: 0.92, phase: index * 0.8 });
  });

  parent.add(group);
}

/** Значок постройки: форма зависит от назначения (порт/аутпост/стройка). */
function structureGeometry(structure: OrreryViewStructure, size: number): THREE.BufferGeometry {
  const type = structure.type.toLowerCase();
  if (type.includes('port') || type.includes('coriolis') || type.includes('orbis')) {
    return new THREE.OctahedronGeometry(size * 0.95, 0);
  }
  if (type.includes('settlement') || type.includes('installation')) {
    return new THREE.ConeGeometry(size * 1.05, size * 1.8, 4);
  }
  if (type.includes('carrier')) {
    return new THREE.BoxGeometry(size * 2.2, size * 0.7, size * 0.8);
  }
  return new THREE.TetrahedronGeometry(size * 1.15, 0);
}

/**
 * Собрать сцену системы.
 *
 * Возвращает корневую группу и индексы; рендерер (`viewer.ts`) сам решает,
 * как часто её рисовать и что делать с наведением.
 */
export function buildOrreryScene(payload: OrreryViewPayload, options: BuildOptions = {}): OrrerySceneModel {
  const span = Math.max(1, payload.span);
  const root = new THREE.Group();
  root.name = 'orrery-root';
  // Пакет живёт в Z-вверх (как журнал), three.js — в Y-вверх.
  root.rotation.x = -Math.PI / 2;

  const groups = {
    grid: new THREE.Group(),
    orbits: new THREE.Group(),
    moonOrbits: new THREE.Group(),
    zones: new THREE.Group(),
    stars: new THREE.Group(),
    planets: new THREE.Group(),
    moons: new THREE.Group(),
    rings: new THREE.Group(),
    structures: new THREE.Group(),
    signals: new THREE.Group(),
    player: new THREE.Group(),
  };
  for (const [name, group] of Object.entries(groups)) {
    group.name = `layer-${name}`;
    root.add(group);
  }

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const registry = { geometries, materials };
  const pickables: THREE.Object3D[] = [];
  const labelAnchors = new Map<string, THREE.Object3D>();
  const structureAnchors = new Map<string, THREE.Object3D>();
  const bodyObjects = new Map<string, THREE.Object3D>();
  const structureObjects = new Map<string, THREE.Object3D>();
  const signalPulses: SignalPulse[] = [];

  // ── Сетка эклиптики: концентрические круги + радиальные лучи ──────────────
  const gridMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(SCENE_COLORS.grid),
    transparent: true,
    opacity: 0.75,
  });
  materials.push(gridMaterial);
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    const radius = span * fraction;
    const geometry = new THREE.BufferGeometry().setFromPoints(
      new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2).getPoints(160)
        .map((point) => new THREE.Vector3(point.x, point.y, 0)),
    );
    geometries.push(geometry);
    groups.grid.add(new THREE.Line(geometry, gridMaterial));
  }
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Math.cos(angle) * span, Math.sin(angle) * span, 0),
    ]);
    geometries.push(geometry);
    const line = new THREE.Line(geometry, gridMaterial);
    if (index % 2 === 1) line.material = gridMaterial;
    groups.grid.add(line);
  }

  // ── Свет: звезда светит на свои планеты ──────────────────────────────────
  const ambient = new THREE.AmbientLight(0x404a5c, 1.1);
  root.add(ambient);
  const starBodies = payload.bodies.filter((body) => body.kind === 'star');
  const glowTexture = createGlowTexture();
  if (glowTexture) textures.push(glowTexture);
  const glowMaterials = new Map<string, THREE.SpriteMaterial>();

  for (const star of starBodies) {
    const position = toVector(star.position);
    const radius = Math.max(span * 0.012, clampRadius(star.marker * 0.09, span) * 3);
    const geometry = new THREE.SphereGeometry(radius, 32, 20);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(star.color) });
    geometries.push(geometry);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.userData.pick = { kind: 'body', name: star.name } satisfies PickInfo;
    groups.stars.add(mesh);
    pickables.push(mesh);
    bodyObjects.set(star.name, mesh);
    labelAnchors.set(star.name, mesh);

    if (glowTexture) {
      const spriteMaterial = new THREE.SpriteMaterial({
        map: glowTexture,
        color: new THREE.Color(star.color),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      glowMaterials.set(star.name, spriteMaterial);
      materials.push(spriteMaterial);
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.scale.setScalar(radius * 9);
      sprite.position.copy(position);
      groups.stars.add(sprite);
    }

    const light = new THREE.PointLight(new THREE.Color(star.color), Math.max(1.4, 3.2 / Math.max(1, starBodies.length)), 0, 1.6);
    light.position.copy(position);
    light.decay = 0;
    groups.stars.add(light);
  }

  // ── Орбиты ───────────────────────────────────────────────────────────────
  const orbitEntries: { object: THREE.Line; material: THREE.LineBasicMaterial; owner: string; name: string; base: number }[] = [];
  const buildOrbit = (orbit: OrreryViewPayload['orbits'][number], group: THREE.Group) => {
    if (orbit.points.length < 2) return;
    const points = orbit.points.map(toVector);
    // Замкнуть петлю: полилиния приходит из расчёта с последней точкой на месте.
    points.push(points[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(orbit.kind === 'moon' ? SCENE_COLORS.orbitMoon : orbit.real ? SCENE_COLORS.orbitReal : SCENE_COLORS.orbit),
      transparent: true,
      opacity: orbit.kind === 'moon' ? BASE_ORBIT_OPACITY * 0.7 : BASE_ORBIT_OPACITY,
    });
    geometries.push(geometry);
    materials.push(material);
    const line = new THREE.Line(geometry, material);
    line.userData.pick = { kind: 'body', name: orbit.name } satisfies PickInfo;
    group.add(line);
    orbitEntries.push({ object: line, material, owner: orbit.owner, name: orbit.name, base: material.opacity });
    return line;
  };
  for (const orbit of payload.orbits) buildOrbit(orbit, groups.orbits);
  for (const orbit of payload.moonOrbits) buildOrbit(orbit, groups.moonOrbits);

  // ── Зоны обитаемости ─────────────────────────────────────────────────────
  for (const zone of payload.zones) {
    if (!(zone.outer > 0)) continue;
    const inner = Math.max(0, Math.min(zone.inner, zone.outer - span * 0.005));
    const geometry = new THREE.RingGeometry(inner, zone.outer, 128, 1);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SCENE_COLORS.habitableZone),
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    geometries.push(geometry);
    materials.push(material);
    const band = new THREE.Mesh(geometry, material);
    band.rotation.x = -Math.PI / 2;
    band.position.copy(toVector(zone.center));
    groups.zones.add(band);

    const edgeGeometry = new THREE.BufferGeometry().setFromPoints(
      new THREE.EllipseCurve(zone.center[0], zone.center[1], zone.outer, zone.outer, 0, Math.PI * 2)
        .getPoints(160)
        .map((point) => new THREE.Vector3(point.x, point.y, zone.center[2])),
    );
    const edgeMaterial = new THREE.LineDashedMaterial({
      color: new THREE.Color(SCENE_COLORS.habitableZone),
      transparent: true,
      opacity: 0.45,
      dashSize: span * 0.012,
      gapSize: span * 0.01,
    });
    geometries.push(edgeGeometry);
    materials.push(edgeMaterial);
    const edge = new THREE.Line(edgeGeometry, edgeMaterial);
    edge.computeLineDistances();
    groups.zones.add(edge);
  }

  // ── Тела ─────────────────────────────────────────────────────────────────
  const bodyMaterials = new Map<string, THREE.Material>();
  for (const body of payload.bodies) {
    if (body.kind === 'star') continue;
    const radius = bodyRadius(body, span);
    const group = new THREE.Group();
    group.position.copy(toVector(body.position));
    group.name = `body-${body.name}`;

    const geometry = new THREE.SphereGeometry(radius, 32, 24);
    // Нарисованные тела не претендуют на настоящую палитру: цвет = класс тела,
    // подсветка — от ближайшей звезды (или ровный свет, если звёзд нет).
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(body.color),
      roughness: 0.92,
      metalness: 0.04,
      emissive: new THREE.Color(body.color).multiplyScalar(starBodies.length ? 0.06 : 0.34),
    });
    geometries.push(geometry);
    materials.push(material);
    bodyMaterials.set(body.name, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.pick = { kind: 'body', name: body.name } satisfies PickInfo;
    group.add(mesh);
    pickables.push(mesh);
    bodyObjects.set(body.name, mesh);
    labelAnchors.set(body.name, mesh);

    addAtmosphereHaze(group, body, radius, body.color, registry);
    addRings(groups.rings, body, radius, registry);
    // Сигналы живут отдельным слоем (их гасят одной галочкой) и потому
    // ставятся в мировых координатах, как кольца.
    addSignalMarkers(groups.signals, body, radius, registry, signalPulses);

    (body.kind === 'moon' ? groups.moons : groups.planets).add(group);
  }

  // ── Постройки и станции ──────────────────────────────────────────────────
  for (const structure of payload.structures) {
    const color = new THREE.Color(structureColor(structure));
    const size = Math.max(span * 0.004, clampRadius(span * 0.012, span));
    const group = new THREE.Group();
    group.position.copy(toVector(structure.position));
    group.name = `structure-${structure.id}`;

    const geometry = structureGeometry(structure, size);
    const material = new THREE.MeshBasicMaterial({ color });
    geometries.push(geometry);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.pick = { kind: 'structure', name: structure.id, body: structure.body } satisfies PickInfo;
    group.add(mesh);
    pickables.push(mesh);
    structureObjects.set(structure.id, mesh);

    // Кольцо прогресса: доля завезённого груза видна прямо на карте.
    const progress = Math.max(0, Math.min(100, structure.progress));
    if (progress > 0 && progress < 100) {
      const ringGeometry = new THREE.RingGeometry(size * 1.9, size * 2.4, 48, 1, 0, (Math.PI * 2 * progress) / 100);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      });
      geometries.push(ringGeometry);
      materials.push(ringMaterial);
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.userData.billboard = true;
      group.add(ring);
    }

    const anchor = new THREE.Object3D();
    anchor.position.set(0, size * 2.6, 0);
    group.add(anchor);
    structureAnchors.set(structure.id, anchor);

    // Стойка к телу: без неё непонятно, к какому телу относится постройка.
    const anchorBody = payload.bodies.find((candidate) => candidate.name === structure.body);
    if (anchorBody && !structure.onSurface) {
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        toVector(anchorBody.position).sub(new THREE.Vector3(...structure.position)).multiplyScalar(-1),
      ]);
      const lineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
      geometries.push(lineGeometry);
      materials.push(lineMaterial);
      group.add(new THREE.Line(lineGeometry, lineMaterial));
    }

    groups.structures.add(group);
  }

  // ── Отметка пилота ───────────────────────────────────────────────────────
  if (payload.player) {
    const size = Math.max(span * 0.008, clampRadius(span * 0.02, span));
    const geometry = new THREE.ConeGeometry(size * 0.6, size * 2, 4);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(SCENE_COLORS.player) });
    geometries.push(geometry);
    materials.push(material);
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(toVector(payload.player.position));
    marker.rotation.z = Math.PI;
    groups.player.add(marker);
    pickables.push(marker);
    marker.userData.pick = { kind: 'body', name: payload.player.body || payload.player.name } satisfies PickInfo;
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...payload.player.position),
      new THREE.Vector3(payload.player.position[0], payload.player.position[1], payload.player.position[2] + size * 2.4),
    ]);
    const lineMaterial = new THREE.LineBasicMaterial({ color: new THREE.Color(SCENE_COLORS.player), transparent: true, opacity: 0.6 });
    geometries.push(lineGeometry);
    materials.push(lineMaterial);
    groups.player.add(new THREE.Line(lineGeometry, lineMaterial));
  }

  const model: OrrerySceneModel = {
    root,
    pickables,
    groups,
    labelAnchors,
    structureAnchors,
    bodyObjects,
    structureObjects,
    setLayer(layer: LayerName, visible: boolean) {
      const group = groups[layer];
      if (group) group.visible = visible;
      if (layer === 'moons') {
        // Луны прячутся вместе со своими орбитами — иначе на карте остаются
        // круги без тел.
        groups.moons.visible = visible;
      }
    },
    setEmphasis(name: string | null) {
      const target = name ? payload.bodies.find((body) => body.name === name) ?? null : null;
      // В системе с одной звездой «свой кластер» — это все тела, поэтому
      // приглушать по кластеру нечего: гасим всё, кроме цели.
      const multiStar = payload.summary.stars > 1;
      const targetStar = multiStar ? target?.star || target?.name || '' : '';
      for (const entry of orbitEntries) {
        const owner = payload.bodies.find((body) => body.name === entry.name);
        const belongsToTargetCluster = multiStar && Boolean(target) && Boolean(owner)
          && (owner!.star === targetStar || owner!.name === targetStar);
        entry.material.opacity = !target || entry.name === name || entry.owner === name || belongsToTargetCluster
          ? entry.base
          : DIM_ORBIT_OPACITY;
      }
      for (const [bodyName, material] of bodyMaterials) {
        const body = payload.bodies.find((candidate) => candidate.name === bodyName);
        const isTarget = !target || bodyName === name;
        const sameCluster = multiStar && Boolean(target) && Boolean(body)
          && (body!.star === targetStar || bodyName === targetStar);
        const opacity = isTarget || sameCluster ? BASE_BODY_OPACITY : DIM_BODY_OPACITY;
        material.opacity = opacity;
        material.transparent = opacity < 1;
        material.needsUpdate = true;
      }
    },
    pulse(timeSeconds: number) {
      // Дышащая метка: масштаб и прозрачность ходят по синусу. Фаза у
      // каждого маячка своя, иначе тело мигает целиком и выглядит ошибкой
      // отрисовки.
      for (const item of signalPulses) {
        const wave = Math.sin(timeSeconds * 2.2 + item.phase);
        const scale = item.baseScale * (1 + wave * 0.12);
        item.object.scale.setScalar(scale);
        item.material.opacity = Math.max(0.06, item.baseOpacity * (0.82 + wave * 0.18));
      }
    },
    dispose() {
      signalPulses.length = 0;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      bodyMaterials.clear();
      labelAnchors.clear();
      structureAnchors.clear();
      bodyObjects.clear();
      structureObjects.clear();
      pickables.length = 0;
      root.clear();
    },
  };

  for (const layer of options.hiddenLayers ?? []) model.setLayer(layer, false);
  return model;
}

/** Разобрать `userData` объекта в данные для карточки (или null). */
export function pickInfoOf(object: THREE.Object3D | null | undefined): PickInfo | null {
  if (!object) return null;
  const data = object.userData?.pick as PickInfo | undefined;
  if (!data) return null;
  return { kind: data.kind, name: data.name, body: data.body };
}
