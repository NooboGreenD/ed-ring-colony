/** Чистая геометрия кольца: общий расчёт для сервера и предварительного контура. */
export interface XYZ { x: number; y: number; z: number }
export interface RingBasis3D {
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  nx: number; ny: number; nz: number;
}

/** Наклон вокруг радиальной оси: стартовая и противоположная точки сохраняют высоту. */
export function ringBasis3D(
  start: XYZ,
  center: XYZ,
  tiltRadians: number,
): RingBasis3D {
  // Горизонтальный вектор от центра к старту (e_radial).
  const dx = start.x - center.x;
  const dz = start.z - center.z;
  const rLen = Math.hypot(dx, dz) || 1;
  const u = { x: dx / rLen, y: 0, z: dz / rLen };
  // Касательный вектор в плоскости XZ. Обход «против часовой сверху» при n=(0,1,0):
  // точка на окружности = R·(cos·u + sin·v0), где v0 = (-uz, 0, ux).
  const v0 = { x: -u.z, y: 0, z: u.x };
  // При tilt=0 n = up = (0,1,0). При повороте плоскости вокруг оси u на угол tilt
  // По формуле Родриго: четверть кольца опускается, три четверти поднимаются.
  //   v = cos·v0 - sin·(0,1,0)
  // Нормаль n = v × u — так, чтобы при tilt=0 получить (0,1,0) вверх.
  const cos = Math.cos(tiltRadians);
  const sin = Math.sin(tiltRadians);
  const v = {
    x: cos * v0.x,
    y: -sin,
    z: cos * v0.z,
  };
  const n = {
    x: v.y * u.z - v.z * u.y,
    y: v.z * u.x - v.x * u.z,
    z: v.x * u.y - v.y * u.x,
  };
  return {
    ux: u.x, uy: u.y, uz: u.z,
    vx: v.x, vy: v.y, vz: v.z,
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
  const max = Math.min(5000, Math.max(-5000, 6000 - baseY - swing));
  const min = Math.max(-5000, Math.min(5000, -6000 - baseY + swing));
  return Math.min(max, Math.max(min, requested));
}
