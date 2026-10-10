import { NextResponse } from 'next/server';
import { mergeCatalog } from '@/lib/outfitting/catalog';
import { loadCatalogSource, readCatalogState } from '@/lib/outfitting/catalogStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Public, read-only effective catalogue. Private audit/actor data stays in admin. */
export async function GET() {
  try {
    const [base, state] = await Promise.all([loadCatalogSource(), readCatalogState()]);
    return NextResponse.json(mergeCatalog(base, state), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Never silently resurrect deleted modules by returning the static source
    // during a configured DB outage. The browser retains its last good copy.
    console.error('[outfitting/catalog]', error);
    return NextResponse.json({ error: 'Каталог верфи временно недоступен. Повторите загрузку позже' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
