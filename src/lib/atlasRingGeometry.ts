/** Чистая геометрия кольца: общий расчёт для сервера и предварительного контура. */
export interface XYZ { x: number; y: number; z: number }
export interface RingBasis3D {
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  nx: number; ny: number; nz: number;
}

/**
 * Поворот плоскости вокруг горизонтальной оси по формуле Родриго.
 * axisRadians — азимут оси относительно направления центр → старт.
 * Нулевой азимут сохраняет старую геометрию; знак наклона меняет сторону.
 */
export function ringBasis3D(
  start: XYZ,
  center: XYZ,
  tiltRadians: number,
  axisRadians = 0,
): RingBasis3D {
  const dx = start.x - center.x, dz = start.z - center.z;
  const length = Math.hypot(dx, dz);
  // Старт прямо над центром: используем определённую ось вместо нулевого базиса.
  const u = length > 1e-9 ? { x: dx / length, y: 0, z: dz / length } : { x: 1, y: 0, z: 0 };
  const v = { x: -u.z, y: 0, z: u.x };
  const axis = {
    x: Math.cos(axisRadians) * u.x + Math.sin(axisRadians) * v.x,
    y: 0,
    z: Math.cos(axisRadians) * u.z + Math.sin(axisRadians) * v.z,
  };
  const rotate = (p: XYZ): XYZ => {
    const c = Math.cos(tiltRadians), s = Math.sin(tiltRadians);
    const dot = axis.x * p.x + axis.z * p.z;
    return {
      x: p.x * c - axis.z * p.y * s + axis.x * dot * (1 - c),
      y: p.y * c + (axis.z * p.x - axis.x * p.z) * s,
      z: p.z * c + axis.x * p.y * s + axis.z * dot * (1 - c),
    };
  };
  const ru = rotate(u), rv = rotate(v);
  const n = {
    x: rv.y * ru.z - rv.z * ru.y,
    y: rv.z * ru.x - rv.x * ru.z,
    z: rv.x * ru.y - rv.y * ru.x,
  };
  return {
    ux: ru.x, uy: ru.y, uz: ru.z,
    vx: rv.x, vy: rv.y, vz: rv.z,
    nx: n.x, ny: n.y, nz: n.z,
  };
}

export function ringPointAtAngle3D(
  ringCenter: XYZ,
  basis: RingBasis3D,
  ringRadius: number,
  angle: number,
): XYZ {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Точка на окружности: R·(cos·u + sin·v) от центра кольца.
  return {
    x: ringCenter.x + ringRadius * (basis.ux * cos + basis.vx * sin),
    y: ringCenter.y + ringRadius * (basis.uy * cos + basis.vy * sin),
    z: ringCenter.z + ringRadius * (basis.uz * cos + basis.vz * sin),
  };
}

/** Ограничение высоты совпадает с планированием серверной сессии. */
export function ringHeightOffset(baseY: number, radius: number, tiltDegrees: number, requested: number): number {
  const swing = radius * Math.abs(Math.sin(tiltDegrees * Math.PI / 180));
  const lower = Math.max(-5000, -6000 - baseY + swing);
  const upper = Math.min(5000, 6000 - baseY - swing);
  if (lower > upper) return Math.max(-5000, Math.min(5000, -baseY));
  return Math.max(lower, Math.min(upper, requested));
}
