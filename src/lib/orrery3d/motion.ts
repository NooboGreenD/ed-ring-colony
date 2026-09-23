/**
 * Движение тел по орбитам: карта должна уметь показать, где тело будет
 * через N суток, а не только точку из последнего скана.
 *
 * Правила те же, что и в раскладке (`systemOrrery.ts`): тело с настоящими
 * элементами идёт по своему эллипсу (уравнение Кеплера, звезда в фокусе),
 * тело без элементов — по нарисованной окружности в её собственной плоскости.
 * Поэтому анимированная точка никогда не сходит с нарисованной орбиты.
 */

import { orbitPoint, solveKepler, trueAnomaly } from '@/lib/systemOrrery';
import type { OrreryViewBody, OrreryViewOrbit, Vec3 } from './types';

export interface OrbitBasis {
  center: Vec3;
  /** Единичный вектор от центра к точке полилинии. */
  u: Vec3;
  /** Второй вектор плоскости (u ⟂ v ⟂ нормаль). */
  v: Vec3;
}

/** Плоскость орбиты по её полилинии — нужна для движения по окружностям. */
export function orbitBasis(orbit: OrreryViewOrbit): OrbitBasis | null {
  if (orbit.points.length < 3) return null;
  const center = orbit.center;
  const first = subtract(orbit.points[0], center);
  if (length(first) < 1e-6) return null;
  const u = normalize(first);
  // Ищем точку, не лежащую на прямой «центр → первая точка».
  let normal: Vec3 | null = null;
  for (const point of orbit.points) {
    const candidate = subtract(point, center);
    const cross = crossProduct(u, candidate);
    if (length(cross) > 1e-6) {
      normal = normalize(cross);
      break;
    }
  }
  if (!normal) return null;
  return { center, u, v: normalize(crossProduct(normal, u)) };
}

/** Угол точки в плоскости орбиты (радианы). */
export function angleInBasis(basis: OrbitBasis, point: Vec3): number {
  const delta = subtract(point, basis.center);
  return Math.atan2(dot(delta, basis.v), dot(delta, basis.u));
}

/** Точка на окружности орбиты по углу в её плоскости. */
export function pointAtAngle(basis: OrbitBasis, angle: number, radius: number): Vec3 {
  return [
    basis.center[0] + radius * (Math.cos(angle) * basis.u[0] + Math.sin(angle) * basis.v[0]),
    basis.center[1] + radius * (Math.cos(angle) * basis.u[1] + Math.sin(angle) * basis.v[1]),
    basis.center[2] + radius * (Math.cos(angle) * basis.u[2] + Math.sin(angle) * basis.v[2]),
  ];
}

/**
 * Какую долю оборота успевает пройти тело за `days` суток.
 *
 * Есть настоящий период — считаем по нему; нет — берём условный «медленный»
 * оборот, чтобы анимация не выглядела замершей для тел без периода в журнале.
 */
export function orbitPhase(body: OrreryViewBody, days: number, fallbackPeriodDays = 400): number {
  const period = body.elements.periodDays > 0 ? body.elements.periodDays : fallbackPeriodDays;
  return days / Math.max(0.01, period);
}

/**
 * Положение тела в момент `timeDays` (сутки от момента скана).
 *
 * Возвращает координаты в тех же unit'ах сцены, что и пакет.
 */
export function positionAtTime(
  body: OrreryViewBody,
  orbit: OrreryViewOrbit | undefined,
  timeDays: number,
): Vec3 {
  if (!orbit || Math.abs(timeDays) < 1e-9) return body.position;
  const phases = orbitPhase(body, timeDays);
  const elements = body.elements;

  if (elements.real && elements.periodDays > 0) {
    const meanAnomaly = (elements.meanAnomalyDeg * Math.PI) / 180 + phases * Math.PI * 2;
    const eccentricity = Math.min(0.98, Math.max(0, elements.eccentricity));
    const anomaly = trueAnomaly(meanAnomaly, eccentricity);
    return orbitPoint(
      orbit.radius,
      anomaly,
      {
        eccentricity,
        inclination: (elements.inclinationDeg * Math.PI) / 180,
        periapsis: (elements.periapsisDeg * Math.PI) / 180,
      },
      orbit.center,
    );
  }

  const basis = orbitBasis(orbit);
  if (!basis) return body.position;
  const angle = angleInBasis(basis, body.position) + phases * Math.PI * 2;
  return pointAtAngle(basis, angle, orbit.radius);
}

/** Сдвиг тела относительно позиции из скана — по нему двигаются его постройки. */
export function positionDelta(from: Vec3, to: Vec3): Vec3 {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

/** Единая точка входа для тестов: угол Кеплера по средней аномалии. */
export function keplerTrueAnomaly(meanAnomalyDeg: number, eccentricity: number): number {
  const eccentricitySafe = Math.min(0.98, Math.max(0, eccentricity));
  const solved = solveKepler((meanAnomalyDeg * Math.PI) / 180, eccentricitySafe);
  return solved;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(point: Vec3): number {
  return Math.hypot(point[0], point[1], point[2]);
}

function normalize(point: Vec3): Vec3 {
  const size = length(point) || 1;
  return [point[0] / size, point[1] / size, point[2] / size];
}

/** Скорости проигрывания: «сколько суток в секунду». */
export const MOTION_SPEEDS = [0.25, 1, 4, 16, 64] as const;
