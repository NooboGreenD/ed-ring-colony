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

// Сколько ждём каждый источник по отдельности. Стройка (RPC по прогрессу) и
// журналы сканирований друг от друга не зависят: если один источник думает
// долго, второй всё равно должен попасть в ответ, а не ждать общего таймаута
// функции. Раньше маршрут ждал оба до победного, и оверлей висел на
// «спрашиваем…».
const PART_TIMEOUT_MS = Number(process.env.ROUTE_HINT_PART_TIMEOUT_MS) || 6000;
// Запасной поиск без учёта регистра идёт без индекса. Ждём его недолго: если
// не успел — ответ помечается неполным и Helper переспросит через минуту.
const RELAXED_SCAN_TIMEOUT_MS = Number(process.env.ROUTE_HINT_RELAXED_TIMEOUT_MS) || 2500;

// Кэш в памяти тёплого экземпляра функции: оверлей после прыжка просит одну и
// ту же систему, а Helper — ещё и соседние по маршруту. Минута совпадает с
// Cache-Control, поэтому свежесть не страдает.
const MEMO_TTL_MS = 60_000;
const MEMO_LIMIT = 500;
const memo = new Map<string, { at: number; body: unknown }>();

function fromMemo(key: string): unknown | null {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(key);
    return null;
  }
  // Освежаем порядок: Map хранит вставку, поэтому переставляем ключ в конец.
  memo.delete(key);
  memo.set(key, hit);
  return hit.body;
}

function toMemo(key: string, body: unknown) {
  memo.set(key, { at: Date.now(), body });
  while (memo.size > MEMO_LIMIT) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

function fail(error: string, status = 503) {
  return NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Дождаться промиса не дольше `ms`, иначе вернуть запасное значение. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  what: string,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const value = await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          console.warn(`[systems/route-hint] ${what}: превышен лимит ${ms} мс, отдаём без него`);
          resolve(fallback);
        }, ms);
      }),
    ]);
    return { value, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SCAN_COLUMNS =
  'body_name,body_type,distance_ls,first_discovered_by,first_mapped_by,first_footfall_by,updated_at';

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

  const memoKey = name.toLowerCase();
  const cached = fromMemo(memoKey);
  if (cached) return NextResponse.json(cached, { headers: CACHE });

  try {
    const svc = createServiceClient();
    const scansQuery = () =>
      // `.eq` попадает в индекс по `system_name`. `ilike` (так было сначала)
      // индекс не использует: PostgREST превращает его в seq scan по всей
      // таблице сканирований, а это и была основная задержка ответа.
      svc.from('system_scans').select(SCAN_COLUMNS).eq('system_name', name)
        .order('distance_ls', { ascending: true })
        .limit(500);

    type Scans = { rows: RouteHintRow[]; timedOut: boolean };

    const loadScans = async (): Promise<Scans> => {
      const exact = await scansQuery();
      if (exact?.error) {
        console.warn('[systems/route-hint] scans', exact.error.message);
        return { rows: [], timedOut: false };
      }
      if (Array.isArray(exact?.data) && exact.data.length > 0) {
        return { rows: exact.data, timedOut: false };
      }
      // Точное совпадение ничего не дало. Регистр в старых загрузках мог быть
      // другим, поэтому проверяем без учёта регистра — но у этого запроса нет
      // индекса (seq scan), а «системы нет в базе» — как раз самый частый
      // случай на маршруте в пустоту. Поэтому у запасного пути свой короткий
      // лимит: лучше честное «спрашиваем дальше», чем ожидание сканирования.
      const relaxed = await within<RouteHintRow[]>(
        Promise.resolve(
        svc.from('system_scans').select(SCAN_COLUMNS)
          .ilike('system_name', name)
          .order('distance_ls', { ascending: true })
          .limit(500)
            .then((result: { data?: RouteHintRow[] | null; error?: { message?: string } | null }) => {
              if (result?.error) {
                console.warn('[systems/route-hint] scans relaxed', result.error.message);
                return [];
              }
              return Array.isArray(result?.data) ? result.data : [];
            }),
        ),
        RELAXED_SCAN_TIMEOUT_MS,
        [],
        'scans relaxed',
      );
      return { rows: relaxed.value, timedOut: relaxed.timedOut };
    };

    const [progressPart, scansPart] = await Promise.all([
      within(
        loadSystemsProgress(svc, [name]).then((rows) => rows[0] ?? null),
        PART_TIMEOUT_MS,
        null,
        'progress',
      ).catch((error: unknown) => {
        console.error('[systems/route-hint] progress', error);
        return { value: null, timedOut: false };
      }),
      within<Scans>(loadScans(), PART_TIMEOUT_MS, { rows: [], timedOut: true }, 'scans')
        .catch((error: unknown) => {
          console.warn('[systems/route-hint] scans', error);
          return { value: { rows: [], timedOut: false } as Scans, timedOut: false };
        }),
    ]);

    const body = buildRouteHint(name, {
      progress: progressPart.value,
      scans: scansPart.value.rows,
    });

    if (progressPart.timedOut || scansPart.timedOut || scansPart.value.timedOut) {
      // Ответ неполный (например, прогресс не успел). Кэшировать его на минуту
      // нельзя: «стройка неизвестна» — не то же самое, что «стройки нет», и
      // оверлей не должен показывать это до истечения кэша. Помечаем ответ как
      // неполный, а Helper переспросит такую систему заметно раньше.
      const partial = { ...body, partial: true };
      return NextResponse.json(partial, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    toMemo(memoKey, body);
    return NextResponse.json(body, { headers: CACHE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[systems/route-hint]', message);
    const missing = /system_progress_sources|schema cache|does not exist/i.test(message);
    return fail(
      missing
        ? 'Подсказка ждёт миграцию 20261020120000_unified_system_data.sql'
        : 'Не удалось собрать подсказку по системе',
    );
  }
}
