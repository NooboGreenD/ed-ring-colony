// TEMPORARY diagnostic endpoint — удалить после отладки.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const URL_RAW =
  'https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article?sort=-published_at&page[offset]=0&page[limit]=10';
const URL_ENC =
  'https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article?sort=-published_at&page%5Boffset%5D=0&page%5Blimit%5D=10';

const VARIANTS: { name: string; headers: Record<string, string> }[] = [
  { name: 'jsonapi-only', headers: { Accept: 'application/vnd.api+json' } },
  {
    name: 'jsonapi+bot-ua',
    headers: {
      Accept: 'application/vnd.api+json',
      'User-Agent': 'ed-ring-colony-galnet-sync/1.0 (+https://github.com/NooboGreenD/ed-ring-colony)',
    },
  },
  {
    name: 'jsonapi+browser-ua',
    headers: {
      Accept: 'application/vnd.api+json, application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  },
  { name: 'no-headers', headers: {} },
];

async function probe(url: string, headers: Record<string, string>) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
    const text = await res.text();
    clearTimeout(timer);

    let parsed = null;
    let dataCount: number | null = null;
    let firstTitles: string[] = [];
    try {
      parsed = JSON.parse(text);
      dataCount = Array.isArray(parsed?.data) ? parsed.data.length : null;
      firstTitles = (parsed?.data || []).slice(0, 3).map((d: any) => d?.attributes?.title ?? null);
    } catch {
      /* not json */
    }

    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bytes: text.length,
      contentType: res.headers.get('content-type'),
      dataCount,
      firstTitles,
      head: text.slice(0, 200),
    };
  } catch (err: any) {
    return { ok: false, error: `${err?.name}: ${err?.message}`, ms: Date.now() - started };
  }
}

export async function GET() {
  const results: Record<string, any> = {};
  for (const variant of VARIANTS) {
    results[`raw|${variant.name}`] = await probe(URL_RAW, variant.headers);
    results[`enc|${variant.name}`] = await probe(URL_ENC, variant.headers);
  }
  return NextResponse.json({ at: new Date().toISOString(), node: process.version, results });
}
