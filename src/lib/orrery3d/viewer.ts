/**
 * Интерактивный 3D-оверей: рендерер, управление, подписи и подсказки.
 *
 * Это единственная часть карты, которая работает с DOM и WebGL. Всё
 * содержательное (раскладка, камера, сцена) живёт в соседних модулях, поэтому
 * поведение проверяется тестами без видеокарты, а подключает рендерер сайт —
 * `src/components/SystemMap/SystemOrrery3D.tsx`.
 *
 * Приложение Colonial Helper рисует ту же сцену своим холстом Tk
 * (`uploader/tk_orrery.py`), поэтому WebGL и сборка движка ему не нужны.
 *
 * Наружу отдаётся маленький API (`focus`, `setZoom`, `setLayer`, `setMotion`,
 * `setFilter`, `on('select')`), чтобы React-обвязка сайта не лезла внутрь
 * three.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CAMERA_FOV_DEG,
  frameFor,
  cameraStateFor,
  interpolateCamera,
  shouldReframeCamera,
  type CameraState,
  type ViewPreset,
  type ZoomLevel,
} from './camera';
import { SIGNAL_META, activeSignalKinds, hasSignals } from '@/lib/bodySignals';
import { MOTION_SPEEDS, orbitalDeltas } from './motion';
import { SCENE_COLORS, structureColor } from './palette';
import {
  DEFAULT_LAYERS,
  buildOrreryScene,
  pickInfoOf,
  type LayerName,
  type OrrerySceneModel,
  type PickInfo,
} from './scene';
import { formatGravity, formatLightSeconds, formatNumber, formatPeriod, formatRadius, formatTons } from './palette';
import type { OrreryViewBody, OrreryViewPayload, OrreryViewStructure } from './types';

/** Объект сцены и его позиция из скана (в координатах пакета). */
interface MotionObject {
  object: THREE.Object3D;
  base: THREE.Vector3;
}

/** Узел модели движения: тело и всё, что обязано ехать вместе с ним. */
interface MotionNode {
  name: string;
  objects: MotionObject[];
}

export type FilterMode = 'all' | 'bodies' | 'landable' | 'bio' | 'signals' | 'sites' | 'rings' | 'unscanned';
export type LabelsMode = 'auto' | 'all' | 'none' | 'focus';

export interface OrreryViewerOptions {
  focus?: string;
  zoom?: ZoomLevel;
  view?: ViewPreset;
  layers?: Partial<Record<LayerName, boolean>>;
  filter?: FilterMode;
  labels?: LabelsMode;
  /** Показывать подсказки при наведении (на сайте — всегда да). */
  tooltips?: boolean;
  /** Автоматически вращать камеру, пока пользователь не тронул мышь. */
  autoRotate?: boolean;
  /** Тема подписей и подсказок. */
  theme?: 'dark' | 'light';
  onSelect?: (pick: PickInfo | null) => void;
  onHover?: (pick: PickInfo | null) => void;
  onState?: (state: OrreryViewerState) => void;
}

export interface OrreryViewerState {
  focus: string;
  zoom: ZoomLevel;
  view: ViewPreset;
  filter: FilterMode;
  labels: LabelsMode;
  layers: Record<LayerName, boolean>;
  playing: boolean;
  speed: number;
  timeDays: number;
}

export interface OrreryViewer {
  /**
   * Обновить данные сцены.
   *
   * `keepFocus` сохраняет выбранное тело, `resetCamera` принудительно
   * кадрирует систему заново. По умолчанию камера НЕ трогается: обновление
   * данных (новые сканы, пересчёт построек, лишний ре-рендер React) не
   * должно выдёргивать её из того положения, куда её поставил человек.
   */
  setPayload: (payload: OrreryViewPayload, options?: { keepFocus?: boolean; resetCamera?: boolean }) => void;
  focus: (target: string, zoom?: ZoomLevel) => void;
  setZoom: (zoom: ZoomLevel) => void;
  setView: (view: ViewPreset) => void;
  setLayer: (layer: LayerName, visible: boolean) => void;
  setLayers: (layers: Partial<Record<LayerName, boolean>>) => void;
  getLayers: () => Record<LayerName, boolean>;
  setFilter: (filter: FilterMode) => void;
  setLabels: (mode: LabelsMode) => void;
  setMotion: (playing: boolean, speed?: number) => void;
  /** Сбросить время к моменту скана. */
  resetTime: () => void;
  fit: () => void;
  getState: () => OrreryViewerState;
  getScene: () => OrrerySceneModel | null;
  on: (event: 'select' | 'hover' | 'state', handler: (payload: any) => void) => () => void;
  dispose: () => void;
}

const STYLE_ID = 'orrery3d-viewer-styles';

/** Стили оверлея подписей и подсказок. */
export function viewerStyles(): string {
  return `
.orrery3d-root { position: relative; overflow: hidden; background: radial-gradient(120% 90% at 50% 0%, ${SCENE_COLORS.backgroundTop} 0%, ${SCENE_COLORS.background} 62%); }
.orrery3d-root canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.orrery3d-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.orrery3d-label { position: absolute; transform: translate(-50%, -100%); white-space: nowrap; font: 500 11px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: ${SCENE_COLORS.label}; text-shadow: 0 1px 3px rgba(0,0,0,.85), 0 0 8px rgba(0,0,0,.7); opacity: .95; }
.orrery3d-label[data-kind="star"] { color: #ffd166; font-weight: 700; letter-spacing: .3px; }
.orrery3d-label[data-kind="moon"] { color: ${SCENE_COLORS.labelMuted}; font-size: 10px; }
.orrery3d-label[data-chip="1"] { padding: 1px 6px; border-radius: 4px; background: rgba(8,12,20,.72); border: 1px solid rgba(120,160,210,.35); }
.orrery3d-label[data-flag] { color: #cfe8ff; }
.orrery3d-label[data-selected="1"] { color: #08131f; background: ${SCENE_COLORS.selection}; border-color: ${SCENE_COLORS.selection}; font-weight: 700; }
.orrery3d-tip { position: absolute; z-index: 5; max-width: 320px; min-width: 200px; padding: 9px 11px; border-radius: 8px;
  background: rgba(9,13,21,.94); border: 1px solid rgba(90,140,200,.4); box-shadow: 0 10px 34px rgba(0,0,0,.55);
  color: #dbe7f5; font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; pointer-events: none; }
.orrery3d-tip[hidden] { display: none; }
.orrery3d-tip h4 { margin: 0 0 4px; font-size: 13px; color: #f8fafc; }
.orrery3d-tip .orrery3d-tip-sub { color: #8fa3bf; font-size: 11px; margin-bottom: 6px; }
.orrery3d-tip dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; }
.orrery3d-tip dt { color: #8fa3bf; }
.orrery3d-tip dd { margin: 0; color: #e6eef8; }
.orrery3d-tip .orrery3d-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.orrery3d-tip .orrery3d-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(90,140,200,.16); border: 1px solid rgba(90,140,200,.32); }
.orrery3d-tip .orrery3d-bar { position: relative; height: 5px; margin-top: 5px; border-radius: 3px; background: rgba(148,163,184,.2); overflow: hidden; }
.orrery3d-tip .orrery3d-bar i { position: absolute; inset: 0 auto 0 0; display: block; }
.orrery3d-toast { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center;
  color: #9fb4cd; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.orrery3d-toast[hidden] { display: none; }
.orrery3d-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: #cbd5e1; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.orrery3d-measure { position: absolute; visibility: hidden; white-space: nowrap; }
`;
}

/** Вставить стили один раз на документ. */
export function injectViewerStyles(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = viewerStyles();
  doc.head.appendChild(style);
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Подсказка по телу: факты, обитаемая зона, кольца, постройки. */
export function bodyTooltipHtml(body: OrreryViewBody, structures: OrreryViewStructure[]): string {
  const rows: [string, string][] = [];
  const kindLabel = body.kind === 'star' ? 'звезда' : body.kind === 'moon' ? 'луна' : 'планета';
  if (body.cls) rows.push(['Класс', body.cls]);
  if (body.distanceLs > 0) rows.push(['От входа', formatLightSeconds(body.distanceLs)]);
  if (body.orbitLs > 0 && body.kind !== 'star') rows.push(['Полуось', formatLightSeconds(body.orbitLs)]);
  if (body.radiusM > 0) rows.push(['Радиус', formatRadius(body.radiusM)]);
  if (body.gravity > 0) rows.push(['Гравитация', formatGravity(body.gravity)]);
  if (body.tempK > 0) rows.push(['Температура', `${formatNumber(body.tempK, 0)} K`]);
  if (body.atmosphere) rows.push(['Атмосфера', body.atmosphere]);
  if (body.volcanism) rows.push(['Вулканизм', body.volcanism]);
  if (body.elements.real && body.elements.periodDays > 0) rows.push(['Период', formatPeriod(body.elements.periodDays)]);
  if (body.habitableBand === 'habitable') rows.push(['Зона', 'в обитаемой зоне ★']);
  else if (body.habitableBand === 'inner') rows.push(['Зона', 'ближе обитаемой зоны']);
  else if (body.habitableBand === 'outer') rows.push(['Зона', 'дальше обитаемой зоны']);

  const tags: string[] = [];
  if (body.landable) tags.push('🛬 посадка');
  // Сигналы тела — по видам: биология, геология, следы людей, стражи,
  // таргоиды. Раньше в подсказке была только биология, и остальные находки
  // приходилось искать в игре вручную.
  for (const kind of activeSignalKinds(body.signals)) {
    const meta = SIGNAL_META[kind];
    tags.push(`${meta.icon} ${meta.short}: ${body.signals[kind]}`);
  }
  if (body.signals.genuses.length) rows.push(['Роды', body.signals.genuses.slice(0, 4).join(', ')]);
  if (body.rings.length) tags.push(`💍 колец: ${body.rings.length}`);
  if (body.mapped) tags.push('🗺 карта');
  if (!body.scanned) tags.push('❔ нет подробного скана');
  if (body.firstDiscoveredBy) tags.push(`🧭 ${body.firstDiscoveredBy}`);
  if (body.firstFootfallBy) tags.push(`👣 ${body.firstFootfallBy}`);

  const structuresHtml = structures.length
    ? `<div style="margin-top:6px">${structures.map((structure) => {
      const color = structureColor(structure);
      const percent = Math.round(structure.progress);
      return `<div style="margin-top:4px">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px">
          <span>${esc(structure.name)}</span>
          <b style="color:${color}">${structure.complete ? 'готово' : `${percent}%`}</b>
        </div>
        <div class="orrery3d-bar"><i style="width:${percent}%;background:${color}"></i></div>
        ${structure.remainingTons > 0 ? `<div style="font-size:10px;color:#8fa3bf">осталось ${formatTons(structure.remainingTons)}</div>` : ''}
      </div>`;
    }).join('')}</div>`
    : '';

  return `
    <h4>${esc(body.name)}</h4>
    <div class="orrery3d-tip-sub">${esc(kindLabel)}${body.star && body.star !== body.name ? ` · ★ ${esc(body.star)}` : ''}</div>
    <dl>${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    ${tags.length ? `<div class="orrery3d-tags">${tags.map((tag) => `<span class="orrery3d-tag">${esc(tag)}</span>`).join('')}</div>` : ''}
    ${structuresHtml}
  `;
}

/** Подсказка по постройке: тип, прогресс, остаток груза и ресурсы. */
export function structureTooltipHtml(structure: OrreryViewStructure): string {
  const color = structureColor(structure);
  const percent = Math.round(structure.progress);
  const resources = structure.resources
    .filter((resource) => resource.remaining > 0)
    .slice(0, 6)
    .map((resource) => `<dt>${esc(resource.name)}</dt><dd>${formatTons(resource.remaining)}</dd>`)
    .join('');
  return `
    <h4>${esc(structure.name)}</h4>
    <div class="orrery3d-tip-sub">${esc(structure.type || 'постройка')}${structure.body ? ` · ${esc(structure.body)}` : ''}</div>
    <div class="orrery3d-bar"><i style="width:${percent}%;background:${color}"></i></div>
    <dl>
      <dt>Готовность</dt><dd>${structure.complete ? 'завершено' : `${percent}%`}</dd>
      ${structure.requiredTons > 0 ? `<dt>Доставлено</dt><dd>${formatTons(structure.providedTons)} из ${formatTons(structure.requiredTons)}</dd>` : ''}
      ${structure.remainingTons > 0 ? `<dt>Осталось</dt><dd>${formatTons(structure.remainingTons)}</dd>` : ''}
      ${resources}
    </dl>
  `;
}

/**
 * Создать оврей внутри контейнера.
 *
 * Возвращает API для обвязки; повторный вызов на том же контейнере нужно
 * предварять `dispose()` — иначе останутся два обработчика и два рендерера.
 */
export function createOrreryViewer(
  container: HTMLElement,
  payload: OrreryViewPayload,
  options: OrreryViewerOptions = {},
): OrreryViewer {
  injectViewerStyles(container.ownerDocument);
  container.classList.add('orrery3d-root');

  let currentPayload = payload;
  let scene: OrrerySceneModel | null = null;
  const listeners: Record<'select' | 'hover' | 'state', Set<(payload: any) => void>> = {
    select: new Set(),
    hover: new Set(),
    state: new Set(),
  };

  const state: OrreryViewerState = {
    focus: options.focus && payload.bodies.some((body) => body.name === options.focus) ? options.focus : '',
    zoom: (options.zoom ?? 0) as ZoomLevel,
    view: options.view ?? 'iso',
    filter: options.filter ?? 'all',
    labels: options.labels ?? 'auto',
    layers: { ...DEFAULT_LAYERS, ...(options.layers ?? {}) },
    playing: false,
    speed: 1,
    timeDays: 0,
  };

  const labelLayer = container.ownerDocument.createElement('div');
  labelLayer.className = 'orrery3d-labels';
  const tooltip = container.ownerDocument.createElement('div');
  tooltip.className = 'orrery3d-tip';
  tooltip.hidden = true;
  const toast = container.ownerDocument.createElement('div');
  toast.className = 'orrery3d-toast';
  toast.hidden = true;
  container.appendChild(labelLayer);
  container.appendChild(tooltip);
  container.appendChild(toast);

  let renderer: THREE.WebGLRenderer | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, container.ownerDocument.defaultView?.devicePixelRatio ?? 1));
    renderer.setSize(container.clientWidth || 800, container.clientHeight || 520, false);
    canvas = renderer.domElement;
    container.appendChild(canvas);
  } catch (error) {
    renderer = null;
    const fallback = container.ownerDocument.createElement('div');
    fallback.className = 'orrery3d-fallback';
    fallback.textContent = '3D-карта недоступна: браузер не дал WebGL. Список тел и построек работает ниже.';
    container.appendChild(fallback);
  }

  if (renderer) {
    camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, currentPayload.span / 5000, currentPayload.span * 60);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.7;
    controls.minDistance = currentPayload.span * 0.02;
    controls.maxDistance = currentPayload.span * 8;
    controls.autoRotate = Boolean(options.autoRotate);
    controls.autoRotateSpeed = 0.35;
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = new THREE.Clock();
  const tempVector = new THREE.Vector3();
  let hover: PickInfo | null = null;
  let pointerInside = false;
  /**
   * Модель движения: что и вокруг чего ходит.
   *
   * Считается один раз на пересборку сцены. Порядок важен: сначала звёзды,
   * потом планеты, потом луны — каждое тело добавляет к своему смещению
   * смещение родителя, иначе луна улетает от «уехавшей» планеты, а планета —
   * от своей звезды в двойной системе.
   */
  let motionModel: MotionNode[] = [];
  let frameRequest = 0;
  let transition: { from: CameraState; to: CameraState; started: number; duration: number } | null = null;
  let labelCache: { text: string; kind: string; flags: string }[] = [];
  /** Когда состояние уходило наружу в последний раз (троттлинг проигрывания). */
  let lastStateEmit = 0;
  /** Где нажали кнопку мыши: клик после перетаскивания камеры — не клик. */
  let pointerDown: { x: number; y: number; time: number } | null = null;
  let dragged = false;

  const now = () => (container.ownerDocument.defaultView?.performance?.now?.() ?? Date.now());

  function emit(event: 'select' | 'hover' | 'state', value: unknown) {
    for (const handler of listeners[event]) handler(value);
  }

  function setToast(message: string) {
    toast.textContent = message;
    toast.hidden = !message;
  }

  function rebuildScene(rebuildOptions: { keepCamera?: boolean } = {}) {
    const previousFocus = state.focus;
    if (scene) {
      scene.root.removeFromParent();
      scene.dispose();
      scene = null;
    }
    scene = buildOrreryScene(currentPayload);
    applyLayers();
    applyFilter();
    applyEmphasis();
    motionModel = buildMotionModel();
    // Сцена собрана по позициям из скана: если время уже идёт, тела нужно
    // сразу поставить туда, где они на текущий момент.
    if (state.timeDays !== 0) applyMotion();
    setToast(currentPayload.bodies.length ? '' : 'Сканов этого тела/системы пока нет — карта пустая.');
    if (previousFocus && !currentPayload.bodies.some((body) => body.name === previousFocus)) {
      state.focus = '';
      state.zoom = 0;
    }
    if (rebuildOptions.keepCamera && camera && controls) {
      // Камера остаётся ровно там, где её оставил пользователь. Пересчитать
      // нужно только зависящие от размаха системы пределы, иначе после
      // обновления данных колесо упирается в старые границы.
      syncCameraLimits();
    } else {
      applyCamera(0);
    }
    emit('state', getState());
  }

  /** Ближняя/дальняя плоскости и пределы приближения зависят от размаха сцены. */
  function syncCameraLimits() {
    if (!camera || !controls) return;
    camera.near = currentPayload.span / 5000;
    camera.far = currentPayload.span * 60;
    camera.updateProjectionMatrix();
    controls.minDistance = currentPayload.span * 0.02;
    controls.maxDistance = currentPayload.span * 8;
  }

  function applyLayers() {
    if (!scene) return;
    for (const [layer, visible] of Object.entries(state.layers) as [LayerName, boolean][]) {
      scene.setLayer(layer, visible);
    }
    // Луны: если слой лун выключен, их орбиты тоже не нужны.
    scene.setLayer('moonOrbits', state.layers.moonOrbits && state.layers.moons);
  }

  function bodyMatchesFilter(body: OrreryViewBody): boolean {
    switch (state.filter) {
      case 'all': return true;
      case 'bodies': return body.kind !== 'star';
      case 'landable': return body.landable;
      case 'bio': return body.bioSignals > 0;
      // «Есть сигналы» — любые: геологические точки, следы людей, стражи.
      case 'signals': return hasSignals(body.signals);
      case 'sites': return body.structures.length > 0;
      case 'rings': return body.rings.length > 0;
      case 'unscanned': return !body.scanned;
      default: return true;
    }
  }

  function applyFilter() {
    if (!scene) return;
    const matching = new Set(currentPayload.bodies.filter(bodyMatchesFilter).map((body) => body.name));
    // Звёзды остаются всегда: без них карта теряет ориентацию.
    for (const body of currentPayload.bodies) if (body.kind === 'star') matching.add(body.name);
    for (const [name, object] of scene.bodyObjects) {
      const body = currentPayload.bodies.find((candidate) => candidate.name === name);
      if (!body) continue;
      const visible = matching.has(name);
      const parent = object.parent;
      if (parent) parent.visible = visible;
    }
    for (const structure of currentPayload.structures) {
      const object = scene.structureObjects.get(structure.id);
      if (!object) continue;
      const group = object.parent;
      if (group) group.visible = state.layers.structures && matching.has(structure.body || currentPayload.system);
    }
    // Метки сигналов идут за своими телами: отфильтрованное тело не должно
    // оставлять на карте висящий в пустоте маячок.
    for (const child of scene.groups.signals.children) {
      const name = String(child.name || '').replace(/^signals-/, '');
      child.visible = !name || matching.has(name);
    }
    for (const line of scene.groups.orbits.children) {
      const name = (line.userData?.pick as PickInfo | undefined)?.name;
      line.visible = state.layers.orbits && (!name || matching.has(name));
    }
    for (const line of scene.groups.moonOrbits.children) {
      const name = (line.userData?.pick as PickInfo | undefined)?.name;
      line.visible = state.layers.moonOrbits && state.layers.moons && (!name || matching.has(name));
    }
  }

  function applyEmphasis() {
    scene?.setEmphasis(state.focus || null);
  }

  function findOrbit(name: string) {
    return currentPayload.orbits.find((orbit) => orbit.name === name)
      ?? currentPayload.moonOrbits.find((orbit) => orbit.name === name);
  }

  /**
   * Собрать модель движения по текущей сцене.
   *
   * Все позиции — в координатах пакета (Z вверх): корневая группа сцены уже
   * повёрнута, поэтому никакой перестановки осей здесь быть не должно.
   * Раньше движение пересчитывало координаты ещё раз ([x, z, −y]) — при
   * включении проигрывания тела мгновенно разлетались с орбит.
   */
  function buildMotionModel(): MotionNode[] {
    if (!scene) return [];
    const nodes: MotionNode[] = [];
    for (const body of currentPayload.bodies) {
      const objects: MotionObject[] = (scene.bodyAttachments.get(body.name) ?? [])
        .map((entry) => ({ object: entry.object, base: entry.base.clone() }));

      // Постройки тела едут вместе с ним: их смещение — смещение тела.
      for (const structure of currentPayload.structures) {
        if (structure.body !== body.name) continue;
        const object = scene.structureObjects.get(structure.id);
        const group = object?.parent ?? object;
        if (!group) continue;
        objects.push({ object: group, base: group.position.clone() });
      }

      if (!objects.length) continue;
      nodes.push({ name: body.name, objects });
    }
    return nodes;
  }

  /**
   * Поставить тела в положение на момент `timeDays`.
   *
   * Позиция считается от скана (а не «прибавить дельту к текущей»), поэтому
   * ошибка не копится и тело никогда не сходит с нарисованной орбиты.
   * `timeDays = 0` — это и есть сброс к моменту скана.
   */
  function applyMotion(timeDays = state.timeDays) {
    if (!scene || !motionModel.length) return;
    const deltas = orbitalDeltas(currentPayload, timeDays);
    for (const node of motionModel) {
      const delta = deltas.get(node.name) ?? [0, 0, 0];
      for (const entry of node.objects) {
        entry.object.position.set(
          entry.base.x + delta[0],
          entry.base.y + delta[1],
          entry.base.z + delta[2],
        );
      }
    }
  }

  function resetMotion() {
    applyMotion(0);
  }

  function applyCamera(durationMs = 700) {
    if (!camera || !controls) return;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 520;
    const aspect = height > 0 ? width / height : 1;
    const frame = frameFor(currentPayload, state.focus, state.zoom, { view: state.view, aspect });
    const target = cameraStateFor(frame, state.view);
    if (durationMs <= 0) {
      camera.position.set(...target.position);
      controls.target.set(...target.target);
      camera.up.set(...target.up);
      controls.update();
      transition = null;
      return;
    }
    const from: CameraState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
    };
    transition = { from, to: target, started: now(), duration: durationMs };
  }

  function resize() {
    if (!renderer || !camera) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.minDistance = currentPayload.span * 0.02;
      controls.maxDistance = currentPayload.span * 8;
    }
    if (transition) {
      transition.to = cameraStateFor(
        frameFor(currentPayload, state.focus, state.zoom, { view: state.view, aspect: width / height }),
        state.view,
      );
    }
  }

  /** Подписи: проекция «якорей» сцены в экранные координаты. */
  function updateLabels() {
    if (!scene || !camera) return;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 520;
    const mode: LabelsMode = state.labels;
    const wanted: { text: string; kind: string; flags: string; x: number; y: number; priority: number; selected: boolean }[] = [];
    const focusBody = state.focus ? currentPayload.bodies.find((body) => body.name === state.focus) : null;

    if (mode !== 'none') {
      for (const body of currentPayload.bodies) {
        const anchor = scene.labelAnchors.get(body.name);
        if (!anchor) continue;
        const structures = currentPayload.structures.filter((structure) => structure.body === body.name);
        const selected = state.focus === body.name;
        const isFocusCluster = Boolean(focusBody) && (body.star === focusBody!.star || body.star === focusBody!.name);
        const showAuto = !currentPayload.crowded
          || selected
          || body.kind === 'star'
          || isFocusCluster
          || structures.length > 0
          || body.bioSignals > 0
          || body.landable;
        const show = mode === 'all' || (mode === 'focus' ? selected : showAuto);
        if (!show) continue;
        const flags = [
          body.landable ? '🛬' : '',
          body.bioSignals > 0 ? '🌿' : '',
          structures.length ? `🏗${structures.length}` : '',
          body.rings.length ? '💍' : '',
          body.habitableBand === 'habitable' ? '🌍' : '',
        ].filter(Boolean).join(' ');
        anchor.getWorldPosition(tempVector);
        const projected = tempVector.clone().project(camera!);
        if (projected.z > 1) continue;
        wanted.push({
          text: body.shortName || body.name,
          kind: body.kind,
          flags,
          x: (projected.x * 0.5 + 0.5) * width,
          y: (-projected.y * 0.5 + 0.5) * height,
          priority: selected ? 0 : body.kind === 'star' ? 1 : body.structures.length ? 2 : body.kind === 'planet' ? 3 : 4,
          selected,
        });
      }
    }

    wanted.sort((left, right) => left.priority - right.priority || left.y - right.y);
    const accepted: { x: number; y: number; w: number; h: number }[] = [];
    const visible = wanted.filter((entry) => {
      const w = Math.max(38, (entry.text.length + entry.flags.length) * 6.2);
      const h = 14;
      const box = { x: entry.x - w / 2, y: entry.y - h - 6, w, h };
      const overlaps = accepted.some((other) => !(
        box.x + box.w < other.x || other.x + other.w < box.x
        || box.y + box.h < other.y || other.y + other.h < box.y
      ));
      if (overlaps) return false;
      accepted.push(box);
      return true;
    });

    // Переиспользуем DOM-узлы: создавать/удалять по 100 элементов в кадре дорого.
    while (labelLayer.childElementCount > visible.length) labelLayer.lastElementChild?.remove();
    visible.forEach((entry, index) => {
      let node = labelLayer.children[index] as HTMLElement | undefined;
      if (!node) {
        node = container.ownerDocument.createElement('div');
        node.className = 'orrery3d-label';
        labelLayer.appendChild(node);
      }
      const text = entry.flags ? `${entry.text} ${entry.flags}` : entry.text;
      const cache = labelCache[index] ?? { text: '', kind: '', flags: '' };
      if (cache.text !== text || cache.kind !== entry.kind || cache.flags !== String(entry.selected)) {
        node.textContent = text;
        node.dataset.kind = entry.kind;
        node.dataset.chip = entry.selected ? '1' : '0';
        node.dataset.selected = entry.selected ? '1' : '0';
        labelCache[index] = { text, kind: entry.kind, flags: String(entry.selected) };
      }
      node.style.transform = `translate(-50%, -100%) translate3d(${entry.x}px, ${entry.y - 6}px, 0)`;
    });
    labelCache.length = visible.length;
  }

  function pickAt(clientX: number, clientY: number): PickInfo | null {
    if (!renderer || !camera || !scene) return null;
    const box = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - box.left) / box.width) * 2 - 1;
    pointer.y = -((clientY - box.top) / box.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // Тела приоритетнее орбит: линия орбиты ловит курсор слишком легко.
    const hits = raycaster.intersectObjects(scene.pickables, true);
    for (const hit of hits) {
      const info = pickInfoOf(hit.object);
      if (info) return info;
    }
    return null;
  }

  function showTooltip(info: PickInfo | null, clientX: number, clientY: number) {
    if (!info || options.tooltips === false) {
      tooltip.hidden = true;
      return;
    }
    if (info.kind === 'body') {
      const body = currentPayload.bodies.find((candidate) => candidate.name === info.name);
      if (!body) {
        tooltip.hidden = true;
        return;
      }
      tooltip.innerHTML = bodyTooltipHtml(
        body,
        currentPayload.structures.filter((structure) => structure.body === body.name),
      );
    } else {
      const structure = currentPayload.structures.find((candidate) => candidate.id === info.name);
      if (!structure) {
        tooltip.hidden = true;
        return;
      }
      tooltip.innerHTML = structureTooltipHtml(structure);
    }
    tooltip.hidden = false;
    const box = container.getBoundingClientRect();
    const width = tooltip.offsetWidth || 280;
    const height = tooltip.offsetHeight || 140;
    const left = Math.min(Math.max(12, clientX - box.left + 14), Math.max(12, box.width - width - 12));
    const top = Math.min(Math.max(12, clientY - box.top + 14), Math.max(12, box.height - height - 12));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function setHover(info: PickInfo | null, clientX = 0, clientY = 0) {
    const same = (hover?.kind === info?.kind) && (hover?.name === info?.name);
    if (!same) {
      hover = info;
      emit('hover', info);
    }
    showTooltip(info, clientX, clientY);
  }

  /**
   * Выбор тела кликом.
   *
   * Камера едет только когда выбрано НОВОЕ тело. Клик по пустоте лишь снимает
   * выделение: раньше он ещё и кадрировал систему заново, поэтому любой промах
   * мимо планеты (в том числе после вращения сцены мышью) отбрасывал камеру
   * в исходный вид. Вернуть обзор можно кнопкой «вся система» / `fit()`.
   */
  function select(info: PickInfo | null) {
    if (info) {
      // Клик по постройке ведёт к её телу: иначе фокус уедет в пустую точку.
      const bodyName = info.kind === 'body' ? info.name : info.body || '';
      if (bodyName && currentPayload.bodies.some((body) => body.name === bodyName)) {
        if (state.focus !== bodyName) {
          state.focus = bodyName;
          state.zoom = state.zoom === 0 ? 2 : state.zoom;
          applyEmphasis();
          applyCamera();
        }
      }
    } else if (state.focus) {
      state.focus = '';
      applyEmphasis();
    }
    emit('select', info);
    emit('state', getState());
  }

  function handlePointerMove(event: PointerEvent) {
    pointerInside = true;
    if (controls?.autoRotate) controls.autoRotate = false;
    // Вращение и панорама мышью заканчиваются событием click. Если не
    // отличать перетаскивание от клика, каждый поворот сцены «выбирал» то,
    // что оказалось под курсором в конце, и камера прыгала.
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) {
      dragged = true;
    }
    const info = pickAt(event.clientX, event.clientY);
    setHover(info, event.clientX, event.clientY);
    if (renderer) renderer.domElement.style.cursor = info ? 'pointer' : 'grab';
  }

  function handlePointerLeave() {
    pointerInside = false;
    setHover(null);
  }

  function handlePointerDown(event: PointerEvent) {
    pointerDown = { x: event.clientX, y: event.clientY, time: now() };
    dragged = false;
  }

  function handleClick(event: MouseEvent) {
    const wasDragged = dragged;
    const held = pointerDown ? now() - pointerDown.time : 0;
    pointerDown = null;
    dragged = false;
    if (!pointerInside) return;
    // Долгое удержание — тоже управление камерой, а не выбор тела.
    if (wasDragged || held > 350) return;
    const info = pickAt(event.clientX, event.clientY);
    select(info);
  }

  function handleDoubleClick(event: MouseEvent) {
    const info = pickAt(event.clientX, event.clientY);
    if (!info) return;
    const bodyName = info.kind === 'body' ? info.name : info.body || '';
    if (state.focus === bodyName) {
      state.zoom = Math.min(3, state.zoom + 1) as ZoomLevel;
      applyCamera();
      emit('state', getState());
    }
  }

  function animate() {
    frameRequest = (container.ownerDocument.defaultView ?? window).requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (state.playing) {
      state.timeDays += delta * state.speed;
      // Положение считается от момента скана, поэтому накопленной ошибки нет
      // и тело не съезжает с нарисованной орбиты даже через сотни кадров.
      applyMotion();
      // Состояние наружу — не чаще 8 раз в секунду. Событие на каждом кадре
      // заставляло React перерисовывать обвязку 60 раз в секунду: интерфейс
      // тормозил, а любой нестабильный пропс страницы возвращал камеру.
      if (now() - lastStateEmit > 125) {
        lastStateEmit = now();
        emit('state', getState());
      }
    }
    if (transition && camera && controls) {
      const progress = Math.min(1, (now() - transition.started) / transition.duration);
      const current = interpolateCamera(transition.from, transition.to, progress);
      camera.position.set(...current.position);
      controls.target.set(...current.target);
      camera.up.set(...current.up);
      if (progress >= 1) transition = null;
    }
    controls?.update();
    scene?.pulse(clock.elapsedTime);
    if (renderer && camera && scene) {
      renderer.render(scene.root, camera);
      updateLabels();
    }
  }

  function bind() {
    if (!renderer) return;
    const element = renderer.domElement;
    element.addEventListener('pointerdown', handlePointerDown);
    element.addEventListener('pointermove', handlePointerMove);
    element.addEventListener('pointerleave', handlePointerLeave);
    element.addEventListener('click', handleClick);
    element.addEventListener('dblclick', handleDoubleClick);
  }

  function unbind() {
    if (!renderer) return;
    const element = renderer.domElement;
    element.removeEventListener('pointerdown', handlePointerDown);
    element.removeEventListener('pointermove', handlePointerMove);
    element.removeEventListener('pointerleave', handlePointerLeave);
    element.removeEventListener('click', handleClick);
    element.removeEventListener('dblclick', handleDoubleClick);
  }

  function getState(): OrreryViewerState {
    return { ...state, layers: { ...state.layers } };
  }

  function setPayload(next: OrreryViewPayload, opts: { keepFocus?: boolean; resetCamera?: boolean } = {}) {
    const previous = currentPayload;
    currentPayload = next;
    if (!opts.keepFocus) {
      // Фокус мог остаться от прошлой системы — иначе камера улетает в никуда.
      state.focus = next.bodies.some((body) => body.name === state.focus) ? state.focus : '';
    }
    // Решение «трогать ли камеру» вынесено в чистую функцию: её проверяют
    // тесты движка, и она же документирует, что обновление данных камеру
    // не сбрасывает (см. shouldReframeCamera).
    const reframe = shouldReframeCamera(previous, next, { focus: state.focus, resetCamera: opts.resetCamera });
    rebuildScene({ keepCamera: !reframe });
  }

  rebuildScene();
  bind();
  animate();

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => resize())
    : null;
  resizeObserver?.observe(container);
  resize();

  return {
    setPayload,
    focus(target: string, zoom?: ZoomLevel) {
      const exists = currentPayload.bodies.some((body) => body.name === target);
      state.focus = exists ? target : '';
      state.zoom = (zoom ?? (exists ? (state.zoom === 0 ? 2 : state.zoom) : 0)) as ZoomLevel;
      applyEmphasis();
      applyCamera();
      emit('state', getState());
    },
    setZoom(zoom: ZoomLevel) {
      state.zoom = zoom;
      applyCamera();
      emit('state', getState());
    },
    setView(view: ViewPreset) {
      state.view = view;
      applyCamera(500);
      emit('state', getState());
    },
    setLayer(layer: LayerName, visible: boolean) {
      state.layers[layer] = visible;
      applyLayers();
      emit('state', getState());
    },
    setLayers(layers) {
      state.layers = { ...state.layers, ...layers };
      applyLayers();
      emit('state', getState());
    },
    getLayers: () => ({ ...state.layers }),
    setFilter(filter: FilterMode) {
      state.filter = filter;
      applyFilter();
      emit('state', getState());
    },
    setLabels(mode: LabelsMode) {
      state.labels = mode;
      if (mode === 'none') labelLayer.replaceChildren();
    },
    setMotion(playing: boolean, speed?: number) {
      state.playing = playing;
      if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) state.speed = speed;
      if (!playing) clock.getDelta();
      emit('state', getState());
    },
    resetTime() {
      state.timeDays = 0;
      resetMotion();
      emit('state', getState());
    },
    fit() {
      state.focus = '';
      state.zoom = 0;
      applyEmphasis();
      applyCamera();
      emit('state', getState());
    },
    getState,
    getScene: () => scene,
    on(event, handler) {
      listeners[event].add(handler);
      return () => listeners[event].delete(handler);
    },
    dispose() {
      (container.ownerDocument.defaultView ?? window).cancelAnimationFrame(frameRequest);
      resizeObserver?.disconnect();
      unbind();
      controls?.dispose();
      scene?.dispose();
      scene = null;
      renderer?.dispose();
      if (canvas?.parentNode) canvas.parentNode.removeChild(canvas);
      labelLayer.remove();
      tooltip.remove();
      toast.remove();
      container.classList.remove('orrery3d-root');
      listeners.select.clear();
      listeners.hover.clear();
      listeners.state.clear();
    },
  };
}

export { MOTION_SPEEDS };
