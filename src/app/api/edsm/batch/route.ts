import { NextResponse } from 'next/server';

const EDSM_BATCH = 25, PARALLEL = 4, MAX_RETRIES = 3;
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchEdsmBatch(names: string[], attempt = 1): Promise<Record<string, { x: number; y: number; z: number } | null>> {
  const params = new URLSearchParams();
  params.append('showCoordinates', '1');
  for (const n of names) params.append('systemName[]', n);
  const url = 'https://www.edsm.net/api-v1/systems?' + params.toString();
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`EDSM HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [];
    const results: Record<string, { x: number; y: number; z: number } | null> = {};
    for (const item of arr) { if (item?.name && item.coords) results[item.name] = { x: item.coords.x, y: item.coords.y, z: item.coords.z }; }
    return results;
  } catch (err: any) {
    if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); return fetchEdsmBatch(names, attempt + 1); }
    throw err;
  }
}

export async function POST(req: Request) {
  const { names } = await req.json();
  if (!Array.isArray(names) || names.length === 0) return NextResponse.json({ error: 'names array required' }, { status: 400 });
  const results: Record<string, { x: number; y: number; z: number } | null> = {};
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += EDSM_BATCH) batches.push(names.slice(i, i + EDSM_BATCH));
  for (let i = 0; i < batches.length; i += PARALLEL) {
    const chunk = batches.slice(i, i + PARALLEL);
    const chunkResults = await Promise.all(
      chunk.map(batch => fetchEdsmBatch(batch).catch(err => { console.error('[EDSM] Batch failed:', batch.slice(0, 3), err.message); return {}; }))
    );
    for (const batchRes of chunkResults) Object.assign(results, batchRes);
  }
  return NextResponse.json({ results, total: names.length, resolved: Object.keys(results).length });
}
