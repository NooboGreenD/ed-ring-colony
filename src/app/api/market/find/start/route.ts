import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

const EDSM_UA = 'ED-Ring-Colony/1.0 (https://ed-ring-colony.vercel.app)';
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

async function getSystemsInSphere(systemName: string, radius: number): Promise<EDSMSystem[]> {
  const res = await fetch(
    `https://www.edsm.net/api-v1/sphere-systems?systemName=${encodeURIComponent(systemName)}&radius=${radius}&showCoordinates=1`,
    { headers: { 'User-Agent': EDSM_UA } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getSystemsInCube(systemName: string, size: number): Promise<EDSMSystem[]> {
  const res = await fetch(
    `https://www.edsm.net/api-v1/cube-systems?systemName=${encodeURIComponent(systemName)}&size=${size}&showCoordinates=1`,
    { headers: { 'User-Agent': EDSM_UA } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getSystemsInCubeAtCoords(coords: EDSMCoords, size: number): Promise<EDSMSystem[]> {
  const params = new URLSearchParams({ x: String(coords.x), y: String(coords.y), z: String(coords.z), size: String(Math.min(size, 200)), showCoordinates: '1' });
  const res = await fetch(`https://www.edsm.net/api-v1/cube-systems?${params.toString()}`, { headers: { 'User-Agent': EDSM_UA } });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getSystemsInRange(systemName: string, radius: number): Promise<EDSMSystem[]> {
  if (radius <= SPHERE_MAX) return getSystemsInSphere(systemName, radius);
  const center = await getSystemCoords(systemName);
  if (!center) return [];
  // EDSM limits a cube request to roughly 200 ly. Tile the requested volume
  // instead of silently searching only the central ~100 ly.
  const cubeSize = 200;
  const step = 180;
  const offsets: number[] = [];
  for (let offset = -Math.ceil(radius / step) * step; offset <= Math.ceil(radius / step) * step; offset += step) offsets.push(offset);
  const requests: Promise<EDSMSystem[]>[] = [];
  for (const dx of offsets) for (const dy of offsets) for (const dz of offsets) {
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance <= radius + cubeSize * 0.9) {
      requests.push(getSystemsInCubeAtCoords({ x: center.x + dx, y: center.y + dy, z: center.z + dz }, cubeSize));
    }
  }
  const responses: EDSMSystem[][] = [];
  for (let index = 0; index < requests.length; index += 8) {
    responses.push(...await Promise.all(requests.slice(index, index + 8)));
  }
  const unique = new Map<string, EDSMSystem>();
  for (const system of responses.flat()) {
    if (system?.name && system.coords) {
      const distance = dist3d(center, system.coords);
      if (distance <= radius) unique.set(system.name.toLowerCase(), { ...system, distance });
    }
  }
  return Array.from(unique.values());
}

async function getSystemCoords(systemName: string): Promise<EDSMCoords | null> {
  const res = await fetch(
    `https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(systemName)}&showCoordinates=1`,
    { headers: { 'User-Agent': EDSM_UA } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.coords || null;
}

function dist3d(a: EDSMCoords, b: EDSMCoords): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { ref_system, radius = 150, mode = 'single', commodity } = body;
    if (!ref_system) {
      return NextResponse.json({ error: 'ref_system is required' }, { status: 400 });
    }

    const rawSystems = await getSystemsInRange(ref_system, radius);

    if (rawSystems.length === 0) {
      return NextResponse.json(
        { error: `No systems found near ${ref_system} within ${radius} ly` },
        { status: 404 }
      );
    }

    // Keep only real, positioned systems and collapse EDSM aliases before a
    // job is stored. Otherwise a duplicate coordinate can later become two
    // interactive markers at one point in the galaxy map.
    const systemsByName = new Map<string, { name: string; distance: number; x: number; y: number; z: number }>();
    for (const rawSystem of rawSystems) {
      const name = String(rawSystem.name || '').trim().replace(/\s+/g, ' ');
      const x = Number(rawSystem.coords?.x);
      const y = Number(rawSystem.coords?.y);
      const z = Number(rawSystem.coords?.z);
      if (!name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const positioned = {
        name,
        distance: Number.isFinite(Number(rawSystem.distance)) ? Number(rawSystem.distance) : 0,
        x,
        y,
        z,
      };
      const key = name.toLowerCase();
      const existing = systemsByName.get(key);
      if (!existing || positioned.distance < existing.distance) systemsByName.set(key, positioned);
    }
    const inSphere = Array.from(systemsByName.values()).sort((left, right) => left.distance - right.distance);

    if (inSphere.length === 0) {
      return NextResponse.json(
        { error: `No positioned systems found near ${ref_system} within ${radius} ly` },
        { status: 404 },
      );
    }

    const svc = createServiceClient();

    const { data: job, error } = await svc
      .from('market_search_jobs')
      .insert({
        ref_system,
        radius,
        mode,
        commodity: mode === 'single' ? commodity : null,
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      job_id: job.id,
      total_systems: inSphere.length,
      status: 'pending',
      systems_list: inSphere,
    });
  } catch (e: any) {
    console.error('[Market Start] Error:', e);
    return NextResponse.json(
      { error: e.message || 'Failed to start search' },
      { status: 500 }
    );
  }
}
