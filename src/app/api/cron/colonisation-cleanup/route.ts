import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Политика хранения `colonisation_events` (и снимков прогресса).
 *
 * Таблица — «история наблюдений» строек, и без чистки она росла бесконечно
 * (12+ ГБ при полезных ~3). Сама чистка — функция
 * `public.colonisation_events_prune(days)` в миграции
 * `20261008000000_colonisation_events_slim_retention.sql`:
 *
 *   • вклады `ColonisationContribution` не читает никто — удаляются целиком;
 *   • состояния старше окна (по умолчанию 60 дней) удаляются, КРОМЕ
 *     последнего снимка каждой площадки — его читает обогащение Raven;
 *   • снимки `construction_depot_snapshots` старше окна удаляются.
 *
 * Окно настраивается `COLONISATION_RETENTION_DAYS` (минимум 7 — защита от
 * опечатки в окружении, которая стёрла бы живую историю).
 */
function retentionDays(): number {
  const parsed = Number(process.env.COLONISATION_RETENTION_DAYS);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(Math.max(Math.trunc(parsed), 7), 3650);
}

async function handle() {
  const svc = createServiceClient();
  const retainDays = retentionDays();

  const { data, error } = await svc.rpc('colonisation_events_prune', {
    p_retain_days: retainDays,
  });

  if (error) {
    // Функция появляется миграцией 20261008000000…: пока её нет, задача
    // честно падает и видно почему, а не «тихо ничего не делает».
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { deleted_events?: number; deleted_snapshots?: number; deleted_contributions?: number }
    | null;

  return NextResponse.json({
    retainDays,
    deleted: {
      events: Number(row?.deleted_events ?? 0),
      snapshots: Number(row?.deleted_snapshots ?? 0),
      contributions: Number(row?.deleted_contributions ?? 0),
    },
  });
}

export async function GET(req: Request) {
  return runCronTask(req, 'colonisation-cleanup', handle);
}

export const POST = GET;
