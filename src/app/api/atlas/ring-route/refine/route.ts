import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const MAX_JUMP = 14.99;
const REFINE_RADIUS = 30;
const UA = 'ED-Ring-Colony/1.0 (ring-refinement)';
type Point = { name: string; x: number; y: number; z: number; source?: string };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function readJson(res: Response) { const text = await res.text(); try { return text ? JSON.parse(text) : null; } catch { return null; } }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function edsmNear(point: Point): Promise<Point[]> {
  try {
    const url = new URL('https://www.edsm.net/api-v1/cube-systems');
    url.searchParams.set('x', String(point.x)); url.searchParams.set('y', String(point.y)); url.searchParams.set('z', String(point.z));
    url.searchParams.set('size', String(REFINE_RADIUS * 2)); url.searchParams.set('showCoordinates', '1');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try { response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    const data = await readJson(response);
    if (!Array.isArray(data)) return [];
    return data.flatMap((row: any) => {
      const c = row?.coords;
      if (!row?.name || !c) return [];
      const item = { name: String(row.name), x: Number(c.x), y: Number(c.y), z: Number(c.z), source: 'edsm' };
      return Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.z) ? [item] : [];
    });
  } catch { return []; }
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify({ event, data })}\n`));
      (async () => {
        try {
          const body = await req.json();
          const input: Point[] = Array.isArray(body.route) ? body.route : [];
          const center: Point = body.center;
          const ringRadius = Number(body.ring_radius) || 23000;
          if (input.length < 3 || !center) throw new Error('Недостаточно данных для уточнения маршрута');
          const svc = createServiceClient();
          const { data: rows } = await svc.from('atlas_ring_system_cache').select('system_name,x,y,z,source').limit(100_000);
          const cached: Point[] = (rows || []).filter((r: any) => Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)) && Number.isFinite(Number(r.z))).map((r: any) => ({ name: r.system_name, x: Number(r.x), y: Number(r.y), z: Number(r.z), source: r.source || 'cache' }));
          const result = input.map((point) => ({ ...point }));
          const used = new Set(result.filter((p) => p.source !== 'triangulated' && !p.name.startsWith('RING TRIANGULATED')).map((p) => p.name.toLowerCase()));
          const discovered = new Map<string, Point>();
          let replacements = 0;

          for (let index = 1; index < result.length - 1; index++) {
            const current = result[index];
            const nearbyCached = cached.filter((candidate) => dist(candidate, current) <= REFINE_RADIUS);
            const nearby = nearbyCached.length ? nearbyCached : await edsmNear(current);
            nearby.forEach((candidate) => discovered.set(candidate.name.toLowerCase(), candidate));
            const previous = result[index - 1]; const next = result[index + 1];
            const currentError = Math.abs(dist(current, center) - ringRadius);
            const candidate = nearby
              .filter((item) => !used.has(item.name.toLowerCase()) && dist(item, previous) <= MAX_JUMP && dist(item, next) <= MAX_JUMP)
              .sort((a, b) => Math.abs(dist(a, center) - ringRadius) - Math.abs(dist(b, center) - ringRadius))[0];
            if (candidate && (current.source === 'triangulated' || current.name.startsWith('RING TRIANGULATED') || Math.abs(dist(candidate, center) - ringRadius) + 0.01 < currentError)) {
              used.delete(current.name.toLowerCase()); used.add(candidate.name.toLowerCase()); result[index] = candidate; replacements++;
            }
            if (index % 10 === 0 || index === result.length - 2) send('progress', { stage: 'refine', percent: Math.round((index / (result.length - 2)) * 100), message: `Уточнение точки ${index} из ${result.length - 2}`, point: index, total: result.length - 2, replacements });
            if (!nearbyCached.length) await wait(35);
          }

          const rowsToSave = Array.from(discovered.values()).map((p) => ({ system_name: p.name, x: p.x, y: p.y, z: p.z, source: p.source || 'edsm', raw_data: { refinement_radius: REFINE_RADIUS }, last_seen_at: new Date().toISOString() }));
          for (let index = 0; index < rowsToSave.length; index += 500) await svc.from('atlas_ring_system_cache').upsert(rowsToSave.slice(index, index + 500), { onConflict: 'system_name' });
          send('result', { route: result, replacements, scanned: result.length - 2, discovered: discovered.size, refine_radius: REFINE_RADIUS, max_jump: MAX_JUMP });
        } catch (error) { send('error', { message: error instanceof Error ? error.message : 'Ошибка уточнения маршрута' }); }
        finally { send('done', {}); controller.close(); }
      })();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
