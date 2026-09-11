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

    let rawSystems: EDSMSystem[] = [];

    if (radius <= SPHERE_MAX) {
      rawSystems = await getSystemsInSphere(ref_system, radius);
    } else {
      const refCoords = await getSystemCoords(ref_system);
      if (!refCoords) {
        return NextResponse.json(
          { error: `Cannot find coordinates for ${ref_system}` },
          { status: 404 }
        );
      }
      const cubeSystems = await getSystemsInCube(ref_system, radius * 2);
      rawSystems = cubeSystems
        .filter((sys) => sys.coords)
        .map((sys) => ({
          ...sys,
          distance: dist3d(refCoords, sys.coords!),
        }))
        .filter((sys) => (sys.distance || 0) <= radius);
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
