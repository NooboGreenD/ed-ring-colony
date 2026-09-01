import { NextResponse } from 'next/server';

const MAX_RETRIES = 3;
const MAX_JUMP = 15;
const EDSM_SPHERE_MAX = 100;
const EDSM_CUBE_MAX = 200;
const MAX_SCAN_POINTS = 30;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchEdsmCoords(name: string, attempt = 1): Promise<{ x: number; y: number; z: number } | null> {
  const params = new URLSearchParams();
  params.append('systemName', name);
  params.append('showCoordinates', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/system?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    if (!res.ok) throw new Error(`EDSM HTTP ${res.status}`);
    const data = await res.json();
    if (data?.coords) return { x: data.coords.x, y: data.coords.y, z: data.coords.z };
    return null;
  } catch (err: any) {
    if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); return fetchEdsmCoords(name, attempt + 1); }
    throw err;
  }
}

async function fetchEdsmSphere(centerName: string, radius: number) {
  const params = new URLSearchParams();
  params.append('systemName', centerName);
  params.append('radius', String(Math.min(radius, EDSM_SPHERE_MAX)));
  params.append('showCoordinates', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/sphere-systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    return (data || [])
      .filter((s: any) => s?.name && s.coords)
      .map((s: any) => ({ name: s.name, x: s.coords.x, y: s.coords.y, z: s.coords.z }));
  } catch (e: any) {
    console.error('[RouteFinder] EDSM sphere error:', e.message);
    return [];
  }
}

async function fetchEdsmCube(coords: { x: number; y: number; z: number }, size: number) {
  const params = new URLSearchParams();
  params.append('x', String(coords.x));
  params.append('y', String(coords.y));
  params.append('z', String(coords.z));
  params.append('size', String(Math.min(size, EDSM_CUBE_MAX)));
  params.append('showCoordinates', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/cube-systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    return (data || [])
      .filter((s: any) => s?.name && s.coords)
      .map((s: any) => ({ name: s.name, x: s.coords.x, y: s.coords.y, z: s.coords.z }));
  } catch (e: any) {
    console.error('[RouteFinder] EDSM cube error:', e.message);
    return [];
  }
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function findRouteAStar(
  start: { x: number; y: number; z: number },
  goal: { x: number; y: number; z: number },
  systems: { name: string; x: number; y: number; z: number }[],
  maxJump: number
) {
  const nodes = [
    { name: '__START__', x: start.x, y: start.y, z: start.z },
    { name: '__GOAL__', x: goal.x, y: goal.y, z: goal.z },
    ...systems,
  ];
  const startIdx = 0, goalIdx = 1;
  const edges: number[][] = [];
  for (let i = 0; i < nodes.length; i++) {
    edges[i] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i !== j && dist(nodes[i], nodes[j]) <= maxJump) edges[i].push(j);
    }
  }
  const openSet = new Set<number>([startIdx]);
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  gScore.set(startIdx, 0);
  fScore.set(startIdx, dist(start, goal));
  while (openSet.size > 0) {
    let current = -1, minF = Infinity;
    for (const idx of openSet) {
      const f = fScore.get(idx) ?? Infinity;
      if (f < minF) { minF = f; current = idx; }
    }
    if (current === goalIdx) {
      const path: { name: string; x: number; y: number; z: number }[] = [];
      let node = goalIdx;
      while (node !== startIdx) {
        const n = nodes[node];
        if (n.name !== '__GOAL__') path.unshift(n);
        node = cameFrom.get(node)!;
      }
      return path;
    }
    openSet.delete(current);
    for (const neighbor of edges[current]) {
      const tentativeG = (gScore.get(current) ?? Infinity) + dist(nodes[current], nodes[neighbor]);
      if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        fScore.set(neighbor, tentativeG + dist(nodes[neighbor], goal));
        openSet.add(neighbor);
      }
    }
  }
  return null;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  try {
    const body = await req.json();
    const { from_system, to_system, max_jump = 15, radius_around_path = 30 } = body;
    if (!from_system || !to_system) {
      return NextResponse.json({ error: 'from_system and to_system required' }, { status: 400 });
    }

    /* ── 1. Координаты ── */
    const [fromCoords, toCoords] = await Promise.all([
      fetchEdsmCoords(from_system),
      fetchEdsmCoords(to_system),
    ]);
    if (!fromCoords) return NextResponse.json({ error: `System "${from_system}" not found` }, { status: 404 });
    if (!toCoords) return NextResponse.json({ error: `System "${to_system}" not found` }, { status: 404 });

    const directDist = dist(fromCoords, toCoords);

    /* ── 2. Стратегия сканирования ── */
    const useCube = radius_around_path > EDSM_SPHERE_MAX;
    const cubeSize = useCube ? Math.min(radius_around_path, EDSM_CUBE_MAX) : 0;
    const scanStep = useCube
      ? Math.max(cubeSize * 0.7, 50)
      : Math.max(max_jump, 10);
    const rawSteps = Math.ceil(directDist / scanStep);
    const steps = Math.min(rawSteps, MAX_SCAN_POINTS);
    const actualStep = steps > 1 ? directDist / steps : directDist;

    const allSystems = new Map<string, { name: string; x: number; y: number; z: number }>();
    let scanPoints = 0;
    let apiRequests = 0;
    let systemsPerScan: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const point = {
        x: fromCoords.x + (toCoords.x - fromCoords.x) * t,
        y: fromCoords.y + (toCoords.y - fromCoords.y) * t,
        z: fromCoords.z + (toCoords.z - fromCoords.z) * t,
      };

      let systemsBatch: { name: string; x: number; y: number; z: number }[] = [];

      if (useCube) {
        /* Для больших радиусов: cube-systems напрямую по координатам */
        systemsBatch = await fetchEdsmCube(point, cubeSize);
        apiRequests++;
        scanPoints++;
      } else {
        /* Для малых радиусов: найти ближайшую систему, затем sphere */
        const nearest = await findNearestSystem(point);
        apiRequests++;
        if (nearest) {
          scanPoints++;
          systemsBatch = await fetchEdsmSphere(nearest.name, radius_around_path);
          apiRequests++;
        }
      }

      systemsPerScan.push(systemsBatch.length);
      for (const sys of systemsBatch) allSystems.set(sys.name, sys);
    }

    allSystems.delete(from_system);
    allSystems.delete(to_system);
    const systems = Array.from(allSystems.values());

    /* ── 3. A* ── */
    const route = findRouteAStar(fromCoords, toCoords, systems, max_jump);
    const graphNodes = systems.length + 2;
    let graphEdges = 0;
    for (let i = 0; i < graphNodes; i++) {
      for (let j = i + 1; j < graphNodes; j++) {
        const a = i === 0 ? fromCoords : i === 1 ? toCoords : systems[i - 2];
        const b = j === 0 ? fromCoords : j === 1 ? toCoords : systems[j - 2];
        if (dist(a, b) <= max_jump) graphEdges++;
      }
    }

    const elapsedMs = Date.now() - startTime;

    if (!route) {
      return NextResponse.json({
        error: 'No route found',
        from: { name: from_system, ...fromCoords },
        to: { name: to_system, ...toCoords },
        direct_distance: Math.round(directDist * 100) / 100,
        systems_scanned: systems.length,
        scan_points: scanPoints,
        api_requests: apiRequests,
        graph_nodes: graphNodes,
        graph_edges: graphEdges,
        elapsed_ms: elapsedMs,
        suggestion: 'Try increasing max_jump or radius_around_path',
      }, { status: 404 });
    }

    const fullRoute = [
      { name: from_system, x: fromCoords.x, y: fromCoords.y, z: fromCoords.z },
      ...route,
      { name: to_system, x: toCoords.x, y: toCoords.y, z: toCoords.z },
    ];

    const jumps = [];
    for (let i = 0; i < fullRoute.length - 1; i++) {
      const d = dist(fullRoute[i], fullRoute[i + 1]);
      jumps.push({ from: fullRoute[i].name, to: fullRoute[i + 1].name, distance: Math.round(d * 100) / 100 });
    }

    return NextResponse.json({
      route: fullRoute,
      jumps,
      summary: {
        total_systems: fullRoute.length,
        total_jumps: jumps.length,
        total_distance: Math.round(directDist * 100) / 100,
        max_jump: Math.max(...jumps.map(j => j.distance)),
        avg_jump: Math.round((jumps.reduce((s, j) => s + j.distance, 0) / jumps.length) * 100) / 100,
      },
      process: {
        from_system,
        to_system,
        direct_distance: Math.round(directDist * 100) / 100,
        max_jump,
        radius_around_path,
        scan_points: scanPoints,
        systems_scanned: systems.length,
        systems_used: systems.length,
        estimated_steps: steps,
        actual_step: Math.round(actualStep * 100) / 100,
        api_requests: apiRequests,
        graph_nodes: graphNodes,
        graph_edges: graphEdges,
        elapsed_ms: elapsedMs,
        strategy: useCube ? 'cube-systems' : 'sphere-systems',
        systems_per_scan: systemsPerScan,
      },
    });
  } catch (err: any) {
    console.error('[RouteFinder] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

async function findNearestSystem(coords: { x: number; y: number; z: number }) {
  const params = new URLSearchParams();
  params.append('x', String(coords.x));
  params.append('y', String(coords.y));
  params.append('z', String(coords.z));
  params.append('size', '10');
  params.append('showCoordinates', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/cube-systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    const systems = (data || [])
      .filter((s: any) => s?.name && s.coords)
      .map((s: any) => ({
        name: s.name,
        x: s.coords.x, y: s.coords.y, z: s.coords.z,
        dist: Math.sqrt((s.coords.x - coords.x) ** 2 + (s.coords.y - coords.y) ** 2 + (s.coords.z - coords.z) ** 2),
      }))
      .sort((a: any, b: any) => a.dist - b.dist);
    return systems[0] || null;
  } catch (e: any) {
    console.error('[RouteFinder] EDSM cube error:', e.message);
    return null;
  }
}
