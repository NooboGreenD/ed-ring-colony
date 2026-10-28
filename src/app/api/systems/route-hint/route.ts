import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { loadSystemsProgress } from '@/lib/systemOverview';
import { buildRouteHint, type RouteHintRow } from '@/lib/routeHint';
import { cleanSystemName } from '@/lib/systemIdentity.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// Подсказка общая для всех: ни профиля зрителя, ни планов в ней нет (планы
// видны только участникам). Поэтому её можно кэшировать на минуту — оверлей
// ходит сюда при смене следующей системы маршрута, а не каждый тик.
const CACHE = { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' };

function fail(error: string, status = 503) {
  return NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * GET /api/systems/route-hint?name=<система> — подсказка для оверлея Route:
 * идёт ли в системе стройка (процент) и кто открыл систему.
 *
 * Ответ намеренно маленький: оверлей — узкий блок поверх игры. Стройка
 * считается тем же расчётом, что у «Проектов систем» и карточки системы
 * (`loadSystemsProgress`: кэш Raven + площадки из журналов), первооткрыватель
 * берётся из `system_scans` проекта. Если системы в базе нет — `discovery.known`
 * равно false, и оверлей честно пишет «ещё не исследована», а не выдумывает имя.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = cleanSystemName(url.searchParams.get('name') ?? '');
  if (!name) return fail('name обязателен', 400);

  try {
    const svc = createServiceClient();
    const [progress, scans] = await Promise.all([
      loadSystemsProgress(svc, [name])
        .then((rows) => rows[0] ?? null)
        .catch((error: unknown) => {
          console.error('[systems/route-hint] progress', error);
          return null;
        }),
      svc
        .from('system_scans')
        .select('body_name,body_type,distance_ls,first_discovered_by,first_mapped_by,first_footfall_by,updated_at')
        .ilike('system_name', name)
        .order('distance_ls', { ascending: true })
        .limit(500)
        .then(
          (result: { data?: RouteHintRow[] | null; error?: { message?: string } | null }) => {
            if (result?.error) {
              console.warn('[systems/route-hint] scans', result.error.message);
              return [];
            }
            return Array.isArray(result?.data) ? result.data : [];
          },
          (error: unknown) => {
            console.warn('[systems/route-hint] scans', error);
            return [];
          },
        ),
    ]);

    return NextResponse.json(buildRouteHint(name, { progress, scans }), { headers: CACHE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[systems/route-hint]', message);
    const missing = /system_progress_sources|schema cache|does not exist/i.test(message);
    return fail(missing ? 'Подсказка ждёт миграцию 20261020120000_unified_system_data.sql' : 'Не удалось собрать подсказку по системе');
  }
}
