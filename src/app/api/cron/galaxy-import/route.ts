import { NextResponse } from 'next/server';

import { runCronTask } from '@/lib/cronAuth';
import { getGalaxyImportStatus, importPercent, startGalaxyImport } from '@/lib/galaxyImportJob';
import { decideScheduledImport } from '@/lib/galaxyImportSchedule';
import { catalogIsComplete } from '@/lib/galaxySystemsDb';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Ночное обновление каталога всех систем (дамп Spansh выходит раз в сутки).
 *
 * Запрос НЕ ждёт окончания импорта: 6 ГиБ скачиваются и пишутся фоном в
 * веб-процессе, а планировщик получает текущее состояние. Прерванный импорт
 * (перезапуск контейнера) продолжается: дамп скачивается заново — gzip нельзя
 * декодировать с середины, — но уже записанные системы пропускаются по
 * сохранённому смещению в распакованном потоке.
 *
 * Включается добавлением `galaxy-import` в JOBS_ENABLED (см. docker-compose.yml
 * и SPANSH-IMPORT.md); вручную — `node scripts/server-jobs.mjs --once galaxy-import`.
 */

const SKIP_REASONS = {
  running: 'import is already running',
  running_elsewhere: 'import is running in another worker',
  fresh: 'catalog is up to date',
} as const;

async function handle() {
  const status = await getGalaxyImportStatus();
  const { state, stats } = status;
  const progress = {
    phase: state.phase,
    percent: importPercent(state),
    processed: state.processed,
    written: state.written,
    // Records skipped on resume; not the task-level `skipped` of the response.
    records_skipped: state.skipped,
    systems_count: state.systems_count || (stats?.systems_count ?? 0),
    bytes_done: state.bytes_done,
    bytes_total: state.bytes_total,
    resume_offset: state.resume_offset,
    interrupted: status.interrupted,
    updated_at: state.updated_at,
  };

  const decision = decideScheduledImport({
    phase: state.phase,
    live: status.live,
    interrupted: status.interrupted,
    resume_offset: state.resume_offset,
    attempts: state.attempts,
    error: state.error,
    finished_at: state.finished_at,
    updated_at: state.updated_at,
    catalog_complete: catalogIsComplete(stats),
  });

  if (decision.action === 'skip') {
    if (decision.reason === 'fresh') {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: SKIP_REASONS.fresh,
        systems_count: stats?.systems_count ?? 0,
      });
    }
    return NextResponse.json({ ok: true, skipped: true, reason: SKIP_REASONS[decision.reason], ...progress });
  }

  if (decision.action === 'fail') {
    return NextResponse.json({ ok: false, error: decision.reason, ...progress }, { status: 500 });
  }

  try {
    const started = await startGalaxyImport({ scheduled: true });
    const resumedFrom = started.resumedFrom ?? 0;
    return NextResponse.json(
      {
        ok: true,
        started: started.started,
        skipped: !started.started,
        reason:
          started.reason ??
          (resumedFrom > 0
            ? `resumed: skipping systems before byte ${resumedFrom} of the decompressed dump`
            : decision.reason === 'restart'
              ? 'restarted an interrupted import from the beginning'
              : 'started'),
        resumed_from: resumedFrom,
        backend: started.state.backend,
        previous_error: state.phase === 'failed' ? state.error : null,
      },
      { status: started.started ? 202 : 409 },
    );
  } catch (error) {
    // Missing DATABASE_URL/SUPABASE_SERVICE_ROLE_KEY lands here: say so exactly.
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message || 'galaxy import could not start' },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return runCronTask(req, 'galaxy-import', handle);
}

export const POST = GET;
