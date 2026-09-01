import { NextResponse } from 'next/server';

const EDSM_BATCH = 25;    // безопасный размер для GET URL
const PARALLEL = 4;       // параллельных запроса
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // мс

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEdsmBatch(names: string[], attempt = 1): Promise<Record<string, { x: number; y: number; z: number } | null>> {
  const params = new URLSearchParams();
  params.append('showCoordinates', '1');
  for (const n of names) params.append('systemName[]', n);

  const url = 'https://www.edsm.net/api-v1/systems?' + params.toString();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`EDSM HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(`EDSM non-JSON response (${contentType}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const arr = Array.isArray(data) ? data : [];
    const results: Record<string, { x: number; y: number; z: number } | null> = {};

    for (const item of arr) {
      if (item && item.name && item.coords) {
        results[item.name] = {
          x: item.coords.x,
          y: item.coords.y,
          z: item.coords.z,
        };
      }
    }
    return results;
  } catch (err: any) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY * attempt);
      return fetchEdsmBatch(names, attempt + 1);
    }
    throw err;
  }
}

export async function POST(req: Request) {
  const { names } = await req.json();
  if (!Array.isArray(names) || names.length === 0) {
    return NextResponse.json({ error: 'names array required' }, { status: 400 });
  }

  const results: Record<string, { x: number; y: number; z: number } | null> = {};

  // Формируем батчи
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += EDSM_BATCH) {
    batches.push(names.slice(i, i + EDSM_BATCH));
  }

  // Обрабатываем батчи пачками по PARALLEL штук
  for (let i = 0; i < batches.length; i += PARALLEL) {
    const chunk = batches.slice(i, i + PARALLEL);
    const chunkResults = await Promise.all(
      chunk.map((batch) => fetchEdsmBatch(batch).catch((err) => {
        console.error('[EDSM] Batch failed:', batch.slice(0, 3), '...', err.message);
        return {} as Record<string, { x: number; y: number; z: number } | null>;
      }))
    );
    for (const batchRes of chunkResults) {
      Object.assign(results, batchRes);
    }
  }

  return NextResponse.json({
    results,
    total: names.length,
    resolved: Object.keys(results).length,
  });
}
