import { NextResponse } from 'next/server';

import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { galaxyArchiveDir, galaxyImportUrl } from '@/lib/galaxyImport';
import {
  cancelGalaxyDownload,
  cancelGalaxyImport,
  getGalaxyImportStatus,
  startGalaxyDownload,
  startGalaxyImport,
} from '@/lib/galaxyImportJob';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

/**
 * Каталог всех систем (Spansh) для админки: статус импорта + управление им.
 * Импорт идёт фоном в веб-процессе, поэтому запросы возвращаются сразу.
 *
 * Действия:
 *  - `start`          — запустить импорт (архив скачивается на диск, если его
 *                       ещё нет; импорт читает файл с диска);
 *  - `cancel`         — остановить импорт;
 *  - `download`       — скачать архив дампа на диск (с возобновлением по
 *                       Range), без запуска импорта;
 *  - `cancel-download`— остановить скачивание архива.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const status = await getGalaxyImportStatus();
    return NextResponse.json(
      {
        success: true,
        dump_url: galaxyImportUrl(),
        archive_dir: galaxyArchiveDir(),
        ...status,
      },
      { headers },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

function allowedDumpUrl(url: string, configured: string): boolean {
  // The server must not fetch an arbitrary URL from a request body: only the
  // Spansh CDN or the mirror configured in GALAXY_IMPORT_URL.
  return /^https:\/\/downloads\.spansh\.co\.uk\//.test(url) || url === configured;
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // An empty body means "start a normal import".
    }

    const action = typeof body.action === 'string' ? body.action : 'start';

    if (action === 'cancel') {
      const result = await cancelGalaxyImport();
      return NextResponse.json({ success: true, cancelled: result.cancelled, state: result.state }, { headers });
    }

    if (action === 'cancel-download') {
      const result = await cancelGalaxyDownload();
      return NextResponse.json(
        { success: true, cancelled: result.cancelled, state: result.state },
        { headers },
      );
    }

    const configured = galaxyImportUrl();
    const requestedUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
    if (requestedUrl && !allowedDumpUrl(requestedUrl, configured)) {
      return NextResponse.json(
        { error: `Допустим только источник https://downloads.spansh.co.uk/… или настроенный GALAXY_IMPORT_URL (${configured})` },
        { status: 400, headers },
      );
    }

    if (action === 'download') {
      const result = await startGalaxyDownload({ url: requestedUrl });
      return NextResponse.json(
        { success: result.started, started: result.started, reason: result.reason ?? null, state: result.state },
        { status: result.started ? 202 : 409, headers },
      );
    }

    if (action !== 'start') {
      return NextResponse.json(
        { error: 'Ожидается action: "start", "cancel", "download" или "cancel-download"' },
        { status: 400, headers },
      );
    }

    const result = await startGalaxyImport({
      url: requestedUrl,
      fresh: body.fresh === true,
      truncate: body.truncate === true,
      skipPoints: body.skip_points === true,
    });
    return NextResponse.json(
      { success: result.started, started: result.started, reason: result.reason ?? null, resumed_from: result.resumedFrom ?? 0, state: result.state },
      { status: result.started ? 202 : 409, headers },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
