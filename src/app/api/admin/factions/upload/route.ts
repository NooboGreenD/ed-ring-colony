import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import {
  BGS_UPLOAD_CHUNK_BYTES,
  BgsUploadError,
  appendBgsUpload,
  bgsUploadInfo,
  cancelBgsUpload,
  finishBgsUpload,
  startBgsUpload,
} from '@/lib/bgsUpload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

function failure(error: unknown) {
  if (error instanceof BgsUploadError) {
    return NextResponse.json(
      { success: false, error: error.message, ...(error.offset != null ? { offset: error.offset } : {}) },
      { status: error.status, headers },
    );
  }
  const message = String((error as Error)?.message ?? error).slice(0, 300);
  console.error('[admin/factions/upload]', message);
  return NextResponse.json({ success: false, error: `Не удалось принять файл: ${message}` }, { status: 500, headers });
}

/**
 * Админка → Игровые данные → Фракции → «Загрузить архив с компьютера».
 *
 * Для сервера, которому EDSM недоступен: администратор скачивает
 * systemsPopulated.json.gz у себя и передаёт его сюда кусками.
 *
 *   * GET                                         — незаконченная загрузка (что и сколько принято);
 *   * POST `{ action: 'start', name, size, lastModified }` — начать или продолжить
 *                                                   тот же файл → `{ offset, chunkBytes }`;
 *   * PUT `?offset=N`, тело — байты куска          — дописать, если N — ровно принятый
 *                                                   размер, иначе 409 `{ offset }`;
 *   * POST `{ action: 'finish' }`                 — проверить (gzip, дамп EDSM) и сделать архивом;
 *   * POST `{ action: 'cancel' }`                 — удалить незаконченную загрузку.
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  return NextResponse.json({ success: true, upload: bgsUploadInfo(), chunkBytes: BGS_UPLOAD_CHUNK_BYTES }, { headers });
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  let body: { action?: unknown; name?: unknown; size?: unknown; lastModified?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    switch (body.action) {
      case 'start': {
        const started = startBgsUpload({ name: body.name, size: body.size, lastModified: body.lastModified });
        return NextResponse.json({ success: true, ...started, chunkBytes: BGS_UPLOAD_CHUNK_BYTES }, { headers });
      }
      case 'finish': {
        const result = await finishBgsUpload();
        return NextResponse.json({ success: true, ...result }, { headers });
      }
      case 'cancel':
        return NextResponse.json({ success: true, ...cancelBgsUpload() }, { headers });
      default:
        return NextResponse.json({ success: false, error: 'Неизвестное действие: нужен start, finish или cancel' }, { status: 400, headers });
    }
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const offset = Number(new URL(req.url).searchParams.get('offset'));
  if (!Number.isFinite(offset) || offset < 0) {
    return NextResponse.json({ success: false, error: 'Нужен ?offset= — с какого байта кусок' }, { status: 400, headers });
  }
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > BGS_UPLOAD_CHUNK_BYTES * 2) {
      return NextResponse.json({ success: false, error: `Кусок больше ${BGS_UPLOAD_CHUNK_BYTES * 2} байт` }, { status: 413, headers });
    }
    const result = await appendBgsUpload(offset, bytes);
    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    return failure(error);
  }
}
