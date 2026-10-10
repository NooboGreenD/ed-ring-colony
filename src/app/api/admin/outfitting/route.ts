import { NextResponse } from 'next/server';
import { requireCatalogAdmin } from '@/lib/outfitting/catalogAuth';
import { applyCatalogCommands, catalogSnapshot, CatalogError, parseCatalogCommands } from '@/lib/outfitting/catalog';
import { catalogStorage, loadCatalogSource, readCatalogState, saveCatalogState } from '@/lib/outfitting/catalogStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

function failure(error: unknown) {
  if (error instanceof CatalogError) return NextResponse.json({ error: error.message }, { status: error.status, ...NO_STORE });
  console.error('[admin/outfitting]', error);
  return NextResponse.json({ error: 'Не удалось выполнить операцию с каталогом верфи' }, { status: 500, ...NO_STORE });
}

export async function GET(request: Request) {
  try {
    const auth = await requireCatalogAdmin(request);
    if ('response' in auth) return auth.response;
    const [base, state] = await Promise.all([loadCatalogSource(), readCatalogState()]);
    return NextResponse.json(catalogSnapshot(base, state, catalogStorage()), NO_STORE);
  } catch (error) { return failure(error); }
}

/** One atomic batch endpoint for CRUD, archiving, restoring and source resets. */
export async function POST(request: Request) {
  try {
    const auth = await requireCatalogAdmin(request);
    if ('response' in auth) return auth.response;
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CatalogError('Ожидается application/json', 415);
    if (Number(request.headers.get('content-length') || 0) > 1_000_000) throw new CatalogError('Запрос превышает 1 МБ', 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 1_000_000) throw new CatalogError('Запрос превышает 1 МБ', 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new CatalogError('Некорректный JSON'); }
    const { revision, commands } = parseCatalogCommands(body);
    const [base, state] = await Promise.all([loadCatalogSource(), readCatalogState()]);
    if (revision !== state.revision) throw new CatalogError('Каталог изменён другим администратором. Обновите список и повторите действие', 409);
    const next = applyCatalogCommands(base, state, commands, auth.actor);
    await saveCatalogState(revision, next);
    return NextResponse.json(catalogSnapshot(base, next, catalogStorage()), NO_STORE);
  } catch (error) { return failure(error); }
}
