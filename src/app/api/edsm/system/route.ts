import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_RETRIES = 2;
const FETCH_TIMEOUT = 8000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchEdsmSystem(name: string, attempt = 1): Promise<any | null> {
  const params = new URLSearchParams();
  params.append('systemName', name);
  params.append('showCoordinates', '1');
  params.append('showId', '1');
  params.append('showPermit', '1');
  const url = 'https://www.edsm.net/api-v1/system?' + params.toString();
  try {
    console.log(`[EDSM System] Attempt ${attempt}: ${url}`);
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }, FETCH_TIMEOUT);
    console.log(`[EDSM System] Attempt ${attempt} status: ${res.status}`);
    if (!res.ok) throw new Error(`EDSM HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[EDSM System] Attempt ${attempt} data type:`, typeof data, Array.isArray(data) ? 'array' : 'object');
    // EDSM returns [] for unknown systems
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return data;
  } catch (err: any) {
    console.error(`[EDSM System] Attempt ${attempt} error:`, err.message);
    if (attempt < MAX_RETRIES) { await sleep(800 * attempt); return fetchEdsmSystem(name, attempt + 1); }
    console.error('[EDSM System] Failed after retries:', err.message);
    return null;
  }
}

async function fetchEdsmBodies(name: string, attempt = 1): Promise<any[] | null> {
  const params = new URLSearchParams();
  params.append('systemName', name);
  try {
    const res = await fetchWithTimeout(
      'https://www.edsm.net/api-system-v1/bodies?' + params.toString(),
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
      FETCH_TIMEOUT,
    );
    if (!res.ok) throw new Error(`EDSM HTTP ${res.status}`);
    const data = await res.json();
    return data?.bodies || null;
  } catch (err: any) {
    if (attempt < MAX_RETRIES) { await sleep(800 * attempt); return fetchEdsmBodies(name, attempt + 1); }
    console.error('[EDSM Bodies] Failed:', err.message);
    return null;
  }
}

function distToSol(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export async function GET(req: Request) {
  const startTime = Date.now();
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get('name')?.trim();
    console.log(`[EDSM System] Request received: name="${name}"`);
    if (!name) {
      return NextResponse.json({ error: 'name parameter required' }, { status: 400 });
    }

    console.log(`[EDSM System] Fetching from EDSM: ${name}`);

    const [systemData, bodiesData] = await Promise.all([
      fetchEdsmSystem(name),
      fetchEdsmBodies(name),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`[EDSM System] Done in ${elapsed}ms. System: ${systemData ? 'OK' : 'FAIL'}, Bodies: ${bodiesData ? bodiesData.length : 'FAIL'}`);

    if (!systemData) {
      console.log(`[EDSM System] System not found: ${name}`);
      return NextResponse.json({ error: `System "${name}" not found or EDSM unavailable` }, { status: 404 });
    }

    const coords = systemData.coords;
    const distanceToSol = coords ? distToSol(coords.x, coords.y, coords.z) : null;

    const stars: any[] = [];
    const planets: any[] = [];

    if (bodiesData && Array.isArray(bodiesData)) {
      for (const body of bodiesData) {
        if (!body) continue;
        const base = {
          id: body.id,
          name: body.name,
          bodyId: body.bodyId,
          type: body.type,
          subType: body.subType,
          distanceToArrival: body.distanceToArrival,
          isLandable: body.isLandable,
          gravity: body.gravity,
          earthMasses: body.earthMasses,
          radius: body.radius,
          surfaceTemperature: body.surfaceTemperature,
          surfacePressure: body.surfacePressure,
          volcanismType: body.volcanismType,
          atmosphereType: body.atmosphereType,
          atmosphereComposition: body.atmosphereComposition,
          solidComposition: body.solidComposition,
          terraformingState: body.terraformingState,
          orbitalPeriod: body.orbitalPeriod,
          semiMajorAxis: body.semiMajorAxis,
          orbitalEccentricity: body.orbitalEccentricity,
          orbitalInclination: body.orbitalInclination,
          argOfPeriapsis: body.argOfPeriapsis,
          rotationalPeriod: body.rotationalPeriod,
          rotationalPeriodTidallyLocked: body.rotationalPeriodTidallyLocked,
          axialTilt: body.axialTilt,
          belts: body.belts,
          parents: body.parents,
        };

        if (body.type === 'Star') {
          stars.push({
            ...base,
            spectralClass: body.spectralClass,
            luminosity: body.luminosity,
            absoluteMagnitude: body.absoluteMagnitude,
            solarMasses: body.solarMasses,
            solarRadius: body.solarRadius,
            age: body.age,
          });
        } else {
          planets.push({
            ...base,
            materials: body.materials,
            rings: body.rings,
            reserveLevel: body.reserveLevel,
          });
        }
      }
    }

    return NextResponse.json({
      name: systemData.name,
      id: systemData.id,
      id64: systemData.id64,
      coords,
      distanceToSol: distanceToSol ? Math.round(distanceToSol * 100) / 100 : null,
      bodyCount: systemData.bodyCount,
      requirePermit: systemData.requirePermit,
      permitName: systemData.permitName,
      information: systemData.information || null,
      primaryStar: systemData.primaryStar || null,
      stars,
      planets,
      edsmUrl: `https://www.edsm.net/en/system/id/${systemData.id}/name/${encodeURIComponent(systemData.name)}`,
    });
  } catch (err: any) {
    console.error('[EDSM System] Unhandled error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
