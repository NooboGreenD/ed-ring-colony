import { NextResponse } from 'next/server';

import { getGalaxyStats } from '@/lib/galaxySystemsDb';
import { getGalaxyImportStatus } from '@/lib/galaxyImportJob';

export const dynamic = 'force-dynamic';

/**
 * Статус загрузки полной таблицы систем Spansh (для UI: счётчики, лейблы,
 * gate «экспериментальный слой всех систем») + состояние импорта.
 *
 * Карта сначала спрашивает этот эндпоинт и только потом тянет ~36 МБ из
 * `/api/galaxy/all-systems`: пустой каталог больше не выглядит как ошибка 404
 * в консоли, а идущий импорт показывается процентом.
 *
 * GET /api/galaxy/stats
 */
export async function GET() {
  const [stats, status] = await Promise.all([
    getGalaxyStats().catch(() => null),
    getGalaxyImportStatus().catch(() => null),
  ]);

  const systemsCount = stats?.systems_count ?? 0;
  const pointsUploaded = stats?.points_uploaded === true;
  // `/api/galaxy/all-systems` умеет собрать облако из таблицы, поэтому для
  // карты важно лишь одно: есть ли в каталоге строки.
  const pointsAvailable = pointsUploaded || systemsCount > 0;
  const state = status?.state;

  return NextResponse.json(
    {
      ready: systemsCount > 0,
      systems_count: systemsCount,
      imported_at: stats?.imported_at ?? null,
      source: stats?.source ?? null,
      points: {
        available: pointsAvailable,
        uploaded: pointsUploaded,
        count: stats?.points_count ?? null,
        bytes: stats?.points_bytes ?? null,
      },
      import: status && state
        ? {
            phase: state.phase,
            live: status.live,
            interrupted: status.interrupted,
            percent: status.percent,
            backend: state.backend,
            can_import: status.backends.backend !== null,
            source: state.source,
            started_at: state.started_at,
            updated_at: state.updated_at,
            finished_at: state.finished_at,
            bytes_done: state.bytes_done,
            bytes_total: state.bytes_total,
            resume_offset: state.resume_offset,
            processed: state.processed,
            written: state.written,
            invalid: state.invalid,
            skipped: state.skipped,
            systems_count: state.systems_count,
            points_count: state.points_count,
            points_bytes: state.points_bytes,
            points_uploaded: state.points_uploaded,
            points_error: state.points_error,
            error: state.error,
            attempts: state.attempts,
          }
        : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
