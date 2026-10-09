import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Чистка журнальных данных по колонизации.
 *
 * Состояния площадок (`colonisation_sites`) не чистятся: там одна строка на
 * площадку, и её читает обогащение Raven. Чистятся снимки прогресса
 * (`construction_depot_snapshots`) старше окна — функция
 * `public.colonisation_retention_prune(days)` из миграции
 * `20261009010000_colonisation_sites.sql`.
 *
 * Окно настраивается `COLONISATION_RETENTION_DAYS` (минимум 7 — защита от
 * опечатки в окружении, которая стёрла бы живую историю).
 *
 * Ответ сообщает, осталась ли старая таблица `colonisation_events`: если да,
 * её надо перенести и удалить через `supabase/maintenance/colonisation_sites_cutover.sql`.
 */
function retentionDays(): number {
  const parsed = Number(process.env.COLONISATION_RETENTION_DAYS);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(Math.max(Math.trunc(parsed), 7), 3650);
}

async function handle() {
  const svc = createServiceClient();
  const retainDays = retentionDays();

  const { data, error } = await svc.rpc('colonisation_retention_prune', {
    p_retain_days: retainDays,
  });

  if (error) {
    // Функция появляется миграцией 20261009010000…: пока её нет, задача
    // честно падает и видно почему, а не «тихо ничего не делает».
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { deleted_snapshots?: number; legacy_events_present?: boolean }
    | null;

  return NextResponse.json({
    retainDays,
    deleted: {
      snapshots: Number(row?.deleted_snapshots ?? 0),
    },
    legacyEventsPresent: Boolean(row?.legacy_events_present),
  });
}

export async function GET(req: Request) {
  return runCronTask(req, 'colonisation-cleanup', handle);
}

export const POST = GET;
