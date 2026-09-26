/**
 * Камера 3D-карты: уровни приближения, кадрирование и плавные переходы.
 *
 * Модуль намеренно не тянет three.js: это чистая математика, которую можно
 * проверять тестами без WebGL. Ту же математику повторяет сцена приложения
 * (`uploader/tk_orrery.py`), поэтому кадры карты на сайте и в окне совпадают.
 *
 * Уровни приближения те же, что и в кнопках интерфейса:
 *   0 — вся система, 1 — кластер звезды, 2 — окрестности тела, 3 — поверхность.
 */

import type { OrreryViewPayload, Vec3 } from './types';

export type ViewPreset = 'iso' | 'top' | 'side';
export type ZoomLevel = 0 | 1 | 2 | 3;

export interface CameraFrame {
  /** Точка, на которую смотрит камера (в координатах пакета, Z вверх). */
  target: Vec3;
  /** Полуразмер кадра в unit'ах сцены — то, что должно поместиться в экран. */
  halfSpan: number;
  /** Расстояние камеры до цели (в тех же unit'ах). */
  distance: number;
  /** Уровень приближения, к которому относится кадр. */
  zoom: ZoomLevel;
  /** Имя тела/звезды фокуса ('' — обзор системы). */
  focus: string;
}

/** Направления камеры — зеркало `CAMERA_DIR` в `systemOrrery.ts` и `orrery.py`. */
export const CAMERA_DIRECTIONS: Record<ViewPreset, Vec3> = {
  iso: [0.62, -0.62, 0.4],
  top: [0.001, 0.001, 1],
  side: [1, 0.001, 0.06],
};

/** Базовый угол обзора камеры: 42° — как у игрового оверлея. */
export const CAMERA_FOV_DEG = 42;

function normalize(point: Vec3): Vec3 {
  const length = Math.hypot(point[0], point[1], point[2]) || 1;
  return [point[0] / length, point[1] / length, point[2] / length];
}

/** Перевести точку пакета (Z вверх) в систему three.js (Y вверх). */
export function toThree(point: Vec3): Vec3 {
  return [point[0], point[2], -point[1]];
}

/** Обратный перевод — для отладки и тестов. */
export function fromThree(point: Vec3): Vec3 {
  return [point[0], -point[2], point[1]];
}

/**
 * Расстояние камеры, при котором полуразмер `halfSpan` попадает в кадр
 * с запасом `pad`. Учитывается и вертикальный, и горизонтальный угол: на
 * узком экране (телефон) сцена обязана влезать по ширине.
 */
export function fitDistance(halfSpan: number, fovDeg = CAMERA_FOV_DEG, aspect = 1, pad = 1.06): number {
  const half = Math.max(halfSpan, 1e-4);
  const fovRad = (fovDeg * Math.PI) / 180;
  const vertical = half / Math.tan(fovRad / 2);
  const safeAspect = aspect > 0.05 ? aspect : 0.05;
  const horizontalFov = 2 * Math.atan(Math.tan(fovRad / 2) * safeAspect);
  const horizontal = half / Math.tan(horizontalFov / 2);
  return Math.max(vertical, horizontal) * pad;
}

/** Соседние тела: окрестность кадрируется так, чтобы они тоже были видны. */
function nearestDistance(payload: OrreryViewPayload, name: string): number {
  const origin = payload.bodies.find((body) => body.name === name);
  if (!origin) return payload.span * 0.2;
  let best = Number.POSITIVE_INFINITY;
  for (const body of payload.bodies) {
    if (body.name === name) continue;
    const distance = Math.hypot(
      body.position[0] - origin.position[0],
      body.position[1] - origin.position[1],
      body.position[2] - origin.position[2],
    );
    if (distance > 1e-4 && distance < best) best = distance;
  }
  return Number.isFinite(best) ? best : payload.span * 0.2;
}

/** Радиус тела в unit'ах (звёзды в пакете держат радиус в маркере). */
function displayRadius(payload: OrreryViewPayload, name: string): number {
  const body = payload.bodies.find((candidate) => candidate.name === name);
  if (!body) return payload.span * 0.005;
  if (body.radius > 0) return body.radius;
  return Math.max(payload.span * 0.003, body.marker * 0.05);
}

/**
 * Кадр камеры для фокуса и уровня приближения.
 *
 * `focus` — пустая строка для обзора системы (уровень 0). Для уровней 1–3
 * выбирается центр и полуразмер кадра, а расстояние считает `fitDistance`,
 * поэтому «зум» никогда не приводит к чёрному экрану: сначала кадр, потом камера.
 */
export function frameFor(
  payload: OrreryViewPayload,
  focus: string,
  zoom: ZoomLevel,
  options: { view?: ViewPreset; aspect?: number; fovDeg?: number; pad?: number } = {},
): CameraFrame {
  const span = Math.max(1, payload.span);
  const view = options.view ?? 'iso';
  const aspect = options.aspect ?? 1;
  const fovDeg = options.fovDeg ?? CAMERA_FOV_DEG;
  const pad = options.pad ?? 1.06;
  const targetName = focus && payload.bodies.some((body) => body.name === focus) ? focus : '';
  const body = targetName ? payload.bodies.find((candidate) => candidate.name === targetName)! : null;

  let center: Vec3 = [0, 0, 0];
  let halfSpan = span;
  let level: ZoomLevel = 0;

  if (body) {
    level = zoom;
    if (zoom === 0) {
      center = body.position;
      halfSpan = span;
    } else if (zoom === 1) {
      const cluster = payload.clusters.find((candidate) => candidate.star === body.name || candidate.bodies.includes(body.name));
      center = cluster ? cluster.center : body.position;
      let extent = 0;
      for (const member of cluster?.bodies ?? []) {
        const point = payload.bodies.find((candidate) => candidate.name === member)?.position;
        if (!point) continue;
        extent = Math.max(extent, Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]));
      }
      halfSpan = Math.min(span, Math.max(extent * 1.18 + span * 0.02, displayRadius(payload, body.name) * 6, span * 0.06));
    } else if (zoom === 2) {
      center = body.position;
      const neighbours = nearestDistance(payload, body.name);
      halfSpan = Math.max(displayRadius(payload, body.name) * 6, Math.min(span * 0.35, neighbours * 0.62), span * 0.02);
    } else {
      center = body.position;
      halfSpan = Math.max(displayRadius(payload, body.name) * 2.4, span * 0.012);
    }
  }

  return {
    target: center,
    halfSpan,
    distance: fitDistance(halfSpan, fovDeg, aspect, pad),
    zoom: level,
    focus: targetName,
  };
}

/** Позиция камеры для кадра: цель + направление вида × расстояние. */
export function cameraPosition(frame: CameraFrame, view: ViewPreset): Vec3 {
  const dir = normalize(CAMERA_DIRECTIONS[view] ?? CAMERA_DIRECTIONS.iso);
  const target = toThree(frame.target);
  return [
    target[0] + dir[0] * frame.distance,
    target[1] + dir[1] * frame.distance,
    target[2] + dir[2] * frame.distance,
  ];
}

/** Вектор «вверх» для вида: сверху камера не может смотреть вдоль собственного up. */
export function cameraUp(view: ViewPreset): Vec3 {
  return view === 'top' ? [0, 0, -1] : [0, 1, 0];
}

export function easeInOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Нужно ли кадрировать сцену заново после обновления пакета данных.
 *
 * Камера принадлежит человеку: он её крутит, приближает и уводит в сторону.
 * Раньше любая пересборка сцены заканчивалась кадрированием «как при
 * открытии», и карта возвращалась в исходный вид от каждого обновления
 * данных — а при частых ре-рендерах камеру вообще нельзя было сдвинуть.
 *
 * Поэтому заново кадрируем только когда смотреть стало не на что:
 *  - открыли другую систему;
 *  - переключили масштаб (орри ↔ линейный) — координаты меняются целиком;
 *  - размах сцены изменился в разы (порог грубый: прилетевший скан далёкого
 *    тела чуть двигает границы и поводом не является);
 *  - выбранное тело пропало из данных, то есть камера смотрит в пустоту.
 */
export function shouldReframeCamera(
  previous: OrreryViewPayload | null,
  next: OrreryViewPayload,
  options: { focus?: string; resetCamera?: boolean } = {},
): boolean {
  if (options.resetCamera === true) return true;
  if (!previous) return true;
  if (previous.system !== next.system) return true;
  if (previous.scaleMode !== next.scaleMode) return true;
  if (!(previous.span > 0)) return true;
  if (Math.abs(next.span - previous.span) > previous.span * 0.5) return true;
  const focus = options.focus ?? '';
  if (focus && !next.bodies.some((body) => body.name === focus)) return true;
  return false;
}

/** Состояние камеры, которое ведёт рендерер: цель (three.js) и её позиция. */
export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/** Состояние камеры для кадра (three.js-координаты). */
export function cameraStateFor(frame: CameraFrame, view: ViewPreset): CameraState {
  return {
    position: cameraPosition(frame, view),
    target: toThree(frame.target),
    up: cameraUp(view),
  };
}

/**
 * Промежуточное состояние камеры при переходе.
 *
 * Позиция интерполируется по дуге (через нормализацию направления), иначе
 * камера «проходит» сквозь центр системы и картинка на миг переворачивается.
 */
export function interpolateCamera(from: CameraState, to: CameraState, t: number): CameraState {
  const eased = easeInOutCubic(t);
  const target = lerpVec(from.target, to.target, eased);
  const fromOffset: Vec3 = [
    from.position[0] - from.target[0],
    from.position[1] - from.target[1],
    from.position[2] - from.target[2],
  ];
  const toOffset: Vec3 = [
    to.position[0] - to.target[0],
    to.position[1] - to.target[1],
    to.position[2] - to.target[2],
  ];
  const fromLength = Math.hypot(...fromOffset) || 1;
  const toLength = Math.hypot(...toOffset) || 1;
  const direction = slerp(normalize(fromOffset), normalize(toOffset), eased);
  const length = lerp(fromLength, toLength, eased);
  return {
    target,
    position: [
      target[0] + direction[0] * length,
      target[1] + direction[1] * length,
      target[2] + direction[2] * length,
    ],
    up: lerpVec(from.up, to.up, eased),
  };
}

/** Сферическая интерполяция направлений (короткой дугой). */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const theta = Math.acos(dot);
  if (theta < 1e-4) return lerpVec(a, b, t);
  const sinTheta = Math.sin(theta);
  const weightA = Math.sin((1 - t) * theta) / sinTheta;
  const weightB = Math.sin(t * theta) / sinTheta;
  return normalize([
    a[0] * weightA + b[0] * weightB,
    a[1] * weightA + b[1] * weightB,
    a[2] * weightA + b[2] * weightB,
  ]);
}

/** Подпись уровня приближения — одна на все интерфейсы. */
export const ZOOM_LABELS: { level: ZoomLevel; label: string; hint: string; icon: string }[] = [
  { level: 0, label: 'Система', hint: 'Вся система целиком', icon: '🌌' },
  { level: 1, label: 'Кластер', hint: 'Тела выбранной звезды', icon: '⭐' },
  { level: 2, label: 'Окрестность', hint: 'Тело и его соседи', icon: '🛰' },
  { level: 3, label: 'Поверхность', hint: 'Постройки на поверхности тела', icon: '🏗' },
];
