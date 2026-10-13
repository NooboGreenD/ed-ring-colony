import { marketUpstream, marketError } from '@/lib/marketUpstream';
import { constructionCommodities } from '@/lib/constructionBlueprints';
import { resolveCommodity } from '@/lib/commodities';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import {
  catalogIsComplete,
  findSystemByName,
  findSystemsInCube,
  getGalaxyStats,
} from '@/lib/galaxySystemsDb';
import {
  boxAround,
  listCachedSystemsInBox,
  saveCachedSystems,
} from '@/lib/atlasSystemCache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
async function resolveRefCoords(
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
  return getSystemCoords(systemName, deadline);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({error:'Некорректные параметры поиска'}, {status:400});
    }
    const ref_system =
      typeof body.ref_system === 'string' ? body.ref_system.trim() : '';
    const radius = body.radius ?? 150;
    const mode = body.mode ?? 'single';
    const commodity = resolveCommodity(
      typeof body.commodity === 'string' ? body.commodity : ''
    );
    const build_type =
      typeof body.build_type === 'string' ? body.build_type : 'all';
    if (
      !Number.isInteger(radius) ||
      radius < 10 ||
      radius > 500 ||
      !['single', 'build'].includes(mode) ||
      (mode === 'single' && !commodity) ||
      (mode === 'build' && !constructionCommodities(build_type).length)
    ) {
      return NextResponse.json(
        {
          error:
            'Укажите корректный товар/тип стройплощадки и радиус 10–500 св.л.',
        },
        { status: 400 }
      );
    }
    const deadline = Date.now() + 45_000;
    if (!ref_system || ref_system.length > 200) {
      return NextResponse.json(
        { error: 'ref_system is required' },
        { status: 400 }
      );
    }

    /*
     * Источники идут по приоритету «проект → кэш → сеть»:
     *   1. каталог Spansh в БД проекта — миллионы систем без обращения к EDSM;
     *   2. кэш Atlas — то, что нашли прошлые поиски;
     *   3. EDSM sphere/cube — только когда локальных данных нет.
     * Раньше старт всегда ходил в EDSM, поэтому сканирование 500 систем
     * начиналось с ожидания сети, а при её сбое поиск вообще не запускался.
     */
    let source = 'edsm';
    let rawSystems: EDSMSystem[] = [];
    const refCoords = await resolveRefCoords(ref_system, deadline);

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

    if (rawSystems.length === 0) {
      return NextResponse.json(
        { error: `No systems found near ${ref_system} within ${radius} ly` },
        { status: 404 }
      );
    }

    // Keep only real, positioned systems and collapse EDSM aliases before a
    // job is stored. Otherwise a duplicate coordinate can later become two
    // interactive markers at one point in the galaxy map.
    const systemsByName = new Map<
      string,
      { name: string; distance: number; x: number; y: number; z: number }
    >();
    for (const rawSystem of rawSystems) {
      const name = String(rawSystem.name || '')
        .trim()
        .replace(/\s+/g, ' ');
      const x = Number(rawSystem.coords?.x);
      const y = Number(rawSystem.coords?.y);
      const z = Number(rawSystem.coords?.z);
      if (
        !name ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      )
        continue;
      const positioned = {
        name,
        distance: Number.isFinite(Number(rawSystem.distance))
          ? Number(rawSystem.distance)
          : 0,
        x,
        y,
        z,
      };
      const key = name.toLowerCase();
      const existing = systemsByName.get(key);
      if (!existing || positioned.distance < existing.distance)
        systemsByName.set(key, positioned);
    }
    const inSphere = Array.from(systemsByName.values()).sort(
      (left, right) => left.distance - right.distance
    );

    if (inSphere.length === 0) {
      return NextResponse.json(
        {
          error: `No positioned systems found near ${ref_system} within ${radius} ly`,
        },
        { status: 404 }
      );
    }

    const svc = createServiceClient();

    // Список систем — в кэш Atlas: следующий поиск в этом районе не пойдёт в EDSM.
    void saveCachedSystems(
      inSphere.map((system) => ({
        name: system.name,
        x: system.x,
        y: system.y,
        z: system.z,
        source,
      }))
    ).catch(() => 0);

    const { data: job, error } = await svc
      .from('market_search_jobs')
      .insert({
        ref_system,
        radius,
        mode,
        commodity: mode === 'single' ? commodity : null,
        build_type: mode === 'build' ? build_type : null,
        status: 'pending',
        total_systems: inSphere.length,
        scanned_systems: 0,
        found_stations: 0,
        current_system: null,
        systems_list: inSphere,
        result: [],
        scan_log: [],
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: marketError(new Error(error.message)) },
        { status: 503 }
      );
    }

    return NextResponse.json({
      job_id: job.id,
      total_systems: inSphere.length,
      status: 'pending',
      systems_list: inSphere,
      source,
    });
  } catch (e: any) {
    console.error('[Market Start] Error:', e);
    return NextResponse.json(
      { error: marketError(e) || 'Не удалось запустить поиск' },
      { status: 500 }
    );
  }
}
