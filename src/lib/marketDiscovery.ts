import { marketUpstream } from '@/lib/marketUpstream';
import { createServiceClient } from '@/lib/supabaseServer';
import { catalogIsComplete, findSystemByName, findSystemsInCube, getGalaxyStats } from '@/lib/galaxySystemsDb';
import { boxAround, listCachedSystemsInBox } from '@/lib/atlasSystemCache';
const SPHERE_MAX = 100;

interface EDSMCoords {
  x: number;
  y: number;
  z: number;
}

interface EDSMSystem {
  name: string;
  coords?: EDSMCoords;
  distance?: number;
}

async function getSystemsInSphere(
  systemName: string,
  radius: number,
  deadline: number
): Promise<EDSMSystem[]> {
  const data = await marketUpstream(
    `/api-v1/sphere-systems?systemName=${encodeURIComponent(systemName)}&radius=${radius}&showCoordinates=1`,
    deadline
  );
  return Array.isArray(data) ? data : [];
}

async function getSystemsInCubeAtCoords(
  coords: EDSMCoords,
  size: number,
  deadline: number
): Promise<EDSMSystem[]> {
  const params = new URLSearchParams({
    x: String(coords.x),
    y: String(coords.y),
    z: String(coords.z),
    size: String(Math.min(size, 200)),
    showCoordinates: '1',
  });
  const data = await marketUpstream(
    `/api-v1/cube-systems?${params.toString()}`,
    deadline
  );
  return Array.isArray(data) ? data : [];
}

async function getSystemsInRange(
  systemName: string,
  radius: number,
  center: EDSMCoords | null,
  deadline: number
): Promise<EDSMSystem[]> {
  if (radius <= SPHERE_MAX)
    return getSystemsInSphere(systemName, radius, deadline);
  if (!center) return [];
  // EDSM limits a cube request to roughly 200 ly. Tile the requested volume
  // instead of silently searching only the central ~100 ly.
  const cubeSize = 200;
  const step = 180;
  const offsets: number[] = [];
  for (
    let offset = -Math.ceil(radius / step) * step;
    offset <= Math.ceil(radius / step) * step;
    offset += step
  )
    offsets.push(offset);
  const requests: Array<() => Promise<EDSMSystem[]>> = [];
  for (const dx of offsets)
    for (const dy of offsets)
      for (const dz of offsets) {
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance <= radius + cubeSize * 0.9) {
          requests.push(() =>
            getSystemsInCubeAtCoords(
              { x: center.x + dx, y: center.y + dy, z: center.z + dz },
              cubeSize,
              deadline
            )
          );
        }
      }
  const responses: EDSMSystem[][] = [];
  for (let index = 0; index < requests.length; index += 8) {
    responses.push(
      ...(await Promise.all(
        requests.slice(index, index + 8).map((run) => run())
      ))
    );
  }
  const unique = new Map<string, EDSMSystem>();
  for (const system of responses.flat()) {
    if (system?.name && system.coords) {
      const distance = dist3d(center, system.coords);
      if (distance <= radius)
        unique.set(system.name.toLowerCase(), { ...system, distance });
    }
  }
  return Array.from(unique.values());
}

async function getSystemCoords(
  systemName: string,
  deadline: number
): Promise<EDSMCoords | null> {
  const data = await marketUpstream(
    `/api-v1/system?systemName=${encodeURIComponent(systemName)}&showCoordinates=1`,
    deadline
  );
  const coords = data?.coords;
  return coords && [coords.x, coords.y, coords.z].every(Number.isFinite)
    ? coords
    : null;
}

function dist3d(a: EDSMCoords, b: EDSMCoords): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Координаты опорной системы: каталог проекта → кэш Atlas → EDSM. */
export async function resolveRefCoords(
  systemName: string,
  deadline: number
): Promise<EDSMCoords | null> {
  try {
    const row = await findSystemByName(systemName);
    if (row) return { x: row.x, y: row.y, z: row.z };
  } catch (error: any) {
    console.error(
      '[Market Start] каталог не ответил по системе:',
      error?.message
    );
  }
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from('atlas_system_cache')
      .select('x,y,z')
      .eq('name_lc', systemName.trim().toLowerCase().replace(/\s+/g, ' '))
      .maybeSingle();
    if (
      data &&
      [data.x, data.y, data.z].every(
        (value) => value != null && Number.isFinite(Number(value))
      )
    ) {
      return { x: Number(data.x), y: Number(data.y), z: Number(data.z) };
    }
  } catch {
    // Кэша может не быть — идём в EDSM.
  }
  try {
    const { data } = await createServiceClient().from('commerce_systems').select('x,y,z')
      .eq('name_lc', systemName.trim().toLowerCase()).maybeSingle();
    if (data && [data.x, data.y, data.z].every((value) => value != null && Number.isFinite(Number(value)))) {
      return { x: Number(data.x), y: Number(data.y), z: Number(data.z) };
    }
  } catch {
    // Commerce migration may not yet be deployed.
  }
  return getSystemCoords(systemName, deadline);
}


/** Broad discovery is delayed until known inhabited systems cannot satisfy the search. */
export async function discoverMarketSystems(ref_system: string, radius: number, refCoords: EDSMCoords | null, deadline: number) {
    let source = 'edsm';
    let rawSystems: EDSMSystem[] = [];

    if (refCoords) {
      try {
        const stats = await getGalaxyStats();
        if (catalogIsComplete(stats)) {
          const rows = await findSystemsInCube({
            x: refCoords.x,
            y: refCoords.y,
            z: refCoords.z,
            half: radius,
            limit: 5000,
          });
          for (const row of rows) {
            const distance = dist3d(refCoords, row);
            if (distance <= radius) {
              rawSystems.push({
                name: row.name,
                coords: { x: row.x, y: row.y, z: row.z },
                distance,
              });
            }
          }
          if (rawSystems.length > 0) source = 'catalog';
        }
      } catch (error: any) {
        console.error('[Market Start] каталог недоступен:', error?.message);
      }

      if (rawSystems.length === 0) {
        const cached = await listCachedSystemsInBox(
          boxAround(refCoords, radius),
          5000
        ).catch(() => []);
        for (const row of cached) {
          const distance = dist3d(refCoords, row);
          if (distance <= radius) {
            rawSystems.push({
              name: row.name,
              coords: { x: row.x, y: row.y, z: row.z },
              distance,
            });
          }
        }
        if (rawSystems.length > 0) source = 'cache';
      }
    }

    if (rawSystems.length === 0) {
      rawSystems = await getSystemsInRange(
        ref_system,
        radius,
        refCoords,
        deadline
      );
    }

    const unique = new Map<string, EDSMSystem>();
    for (const raw of rawSystems) {
      const name = String(raw.name || '').trim().replace(/\s+/g, ' ');
      const coords = { x: Number(raw.coords?.x), y: Number(raw.coords?.y), z: Number(raw.coords?.z) };
      if (!name || name.length > 200 || ![coords.x, coords.y, coords.z].every(Number.isFinite)) continue;
      const distance = refCoords ? dist3d(refCoords, coords) : Number(raw.distance);
      if (!Number.isFinite(distance) || distance < 0 || distance > radius) continue;
      unique.set(name.toLowerCase(), { name, coords, distance });
    }
    return { systems: Array.from(unique.values()).sort((a, b) => a.distance! - b.distance!), source };
}
