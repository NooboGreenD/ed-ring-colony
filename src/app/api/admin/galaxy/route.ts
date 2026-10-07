import { NextResponse } from 'next/server';

import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { galaxyArchiveDir, galaxyDownloadSegments, galaxyImportUrl } from '@/lib/galaxyImport';
import { DUMP_LADDER, DUMP_VARIANTS, dumpBaseUrl, isDumpVariant } from '@/lib/galaxyDumpVariants';
import {
  cancelGalaxyDownload,
  cleanupGalaxyDisk,
  cancelGalaxyImport,
  cancelGalaxyUnpack,
  checkGalaxyDbConnection,
  getGalaxyImportStatus,
  getGalaxyPointsBuildState,
  planGalaxyImport,
  startGalaxyDownload,
  startGalaxyImport,
  startGalaxyPointsBuild,
  startGalaxyUnpack,
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
 *                       ещё нет; импорт читает файл с диска). Необязательные
 *                       `variant` (`auto`|`full`|`1day`|`1week`|`2weeks`|
 *                       `1month`|`6months`) и `mode` (`auto`|`stream`|`shards`);
 *  - `cancel`         — остановить импорт;
 *  - `download`       — скачать архив дампа на диск (параллельные Range-соединения
 *                       с возобновлением), без запуска импорта;
 *  - `cancel-download`— остановить скачивание архива;
 *  - `unpack`         — распаковать архив в шарды (быстрое возобновление);
 *  - `cancel-unpack`  — остановить распаковку;
 *  - `plan`           — какой дамп нужен прямо сейчас (без загрузки);
 *  - `cleanup`        — освободить место: удалить архивы, которые больше не
 *                       нужны (и шарды без архива); `drop_shards` удаляет и
 *                       шарды тоже;
 *  - `check-db`       — проверить прямое подключение к Postgres и объяснить
 *                       ошибку (например, «getaddrinfo EAI_AGAIN db»);
 *  - `build-points`   — пересобрать облако точек для слоя карты из уже
 *                       импортированной таблицы и положить его в хранилище.
 *                       Идёт фоном; прогресс — в `points_build` статуса.
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
        download_segments: galaxyDownloadSegments(),
        // The whole ladder, so the panel can offer «обновить за сутки/неделю/
        // месяц» without hardcoding Spansh file names in the browser bundle.
        variants: DUMP_LADDER.map((variant) => ({
          variant,
          file: DUMP_VARIANTS[variant].file,
          label: DUMP_VARIANTS[variant].label,
          approx_bytes: DUMP_VARIANTS[variant].approxBytes,
        })),
        ...status,
        points_build: getGalaxyPointsBuildState(),
      },
      { headers },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

function allowedDumpUrl(url: string, configured: string): boolean {
  // The server must not fetch an arbitrary URL from a request body: only the
  // Spansh CDN, the configured mirror directory (GALAXY_DUMP_BASE_URL) or the
  // exact file from GALAXY_IMPORT_URL.
  return /^https:\/\/downloads\.spansh\.co\.uk\//.test(url) || url.startsWith(dumpBaseUrl()) || url === configured;
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

    const requestedVariant = isDumpVariant(body.variant) ? body.variant : body.variant === 'auto' ? 'auto' : undefined;
    if (body.variant !== undefined && requestedVariant === undefined) {
      return NextResponse.json(
        { error: `Неизвестный дамп: ожидается auto или один из ${DUMP_LADDER.join(', ')}` },
        { status: 400, headers },
      );
    }

    if (action === 'plan') {
      const plan = await planGalaxyImport();
      return NextResponse.json({ success: true, plan }, { headers });
    }

    if (action === 'cleanup') {
      const result = await cleanupGalaxyDisk({ dropShards: body.drop_shards === true });
      return NextResponse.json(
        {
          success: result.cleaned,
          cleaned: result.cleaned,
          reason: result.reason ?? null,
          freed: result.freed,
          removed: result.removed,
          storage: result.storage,
        },
        { status: result.cleaned ? 200 : 409, headers },
      );
    }

    if (action === 'unpack') {
      const result = await startGalaxyUnpack({ fresh: body.fresh === true });
      return NextResponse.json(
        { success: result.started, started: result.started, reason: result.reason ?? null, archive: result.archive ?? null },
        { status: result.started ? 202 : 409, headers },
      );
    }

    if (action === 'cancel-unpack') {
      const result = await cancelGalaxyUnpack();
      return NextResponse.json({ success: true, cancelled: result.cancelled }, { headers });
    }

    if (action === 'check-db') {
      const check = await checkGalaxyDbConnection();
      return NextResponse.json({ success: true, check }, { headers });
    }

    if (action === 'build-points') {
      const result = await startGalaxyPointsBuild();
      return NextResponse.json(
        { success: result.started, started: result.started, reason: result.reason ?? null, points_build: result.state },
        { status: result.started ? 202 : 409, headers },
      );
    }

    if (action === 'download') {
      const result = await startGalaxyDownload({ url: requestedUrl, variant: requestedVariant });
      return NextResponse.json(
        {
          success: result.started,
          started: result.started,
          reason: result.reason ?? null,
          state: result.state,
          plan: result.plan ?? null,
        },
        { status: result.started ? 202 : 409, headers },
      );
    }

    if (action !== 'start') {
      return NextResponse.json(
        {
          error:
            'Ожидается action: "start", "cancel", "download", "cancel-download", "unpack", "cancel-unpack", "plan", "cleanup", "check-db" или "build-points"',
        },
        { status: 400, headers },
      );
    }

    const requestedMode =
      body.mode === 'stream' || body.mode === 'shards' || body.mode === 'auto' ? body.mode : undefined;

    const result = await startGalaxyImport({
      url: requestedUrl,
      variant: requestedVariant,
      mode: requestedMode,
      fresh: body.fresh === true,
      truncate: body.truncate === true,
      skipPoints: body.skip_points === true ? true : body.skip_points === false ? false : undefined,
    });
    return NextResponse.json(
      {
        success: result.started,
        started: result.started,
        reason: result.reason ?? null,
        resumed_from: result.resumedFrom ?? 0,
        resumed_shard: result.resumedShard ?? 0,
        variant: result.variant ?? null,
        mode: result.mode ?? null,
        plan: result.plan ?? null,
        state: result.state,
      },
      { status: result.started ? 202 : 409, headers },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
