import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { readStorageHealth, restartStorage } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Supabase Storage: состояние и перезапуск (Админка → Мониторинг).
 *
 * Storage — отдельный стек, который обновление проекта не трогает: когда его
 * контейнер падает, сайт живёт, а аватары и логотипы эскадрилий молча уходят
 * в резервную таблицу. Раньше это лечилось только по SSH; теперь — кнопкой.
 *
 * GET  — только чтение (`deploy/storage-repair.sh --check`), можно опрашивать
 *        сколько угодно: панель показывает состояние и «повод».
 * POST — перезапуск тем же скриптом: он сам проверяет и не трогает сервис,
 *        если тот работает. Занимает общий слот задач агента (kind=storage),
 *        поэтому не пересекается с обновлением и бэкапом.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const result = await readStorageHealth();
    if (!result.ok || !result.payload) {
      // 404 — работающий агент ещё не знает /storage: он старее сайта и
      // подхватит код после перезапуска (кнопка в блоке «Обновление проекта»).
      const stale = result.status === 404;
      return NextResponse.json(
        {
          error: stale
            ? 'Update-агент старее сайта и не умеет проверять Storage — перезапустите агент в блоке «Обновление проекта»'
            : result.error || 'Не удалось проверить Storage',
        },
        { status: stale ? 503 : result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({
      success: true,
      available: result.payload.available === true,
      reason: result.payload.reason ?? null,
      report: result.payload.report ?? null,
      detail: Array.isArray(result.payload.detail) ? result.payload.detail : [],
      busy: result.payload.busy === true,
    }, NO_STORE);
  } catch (error) {
    console.error('[admin/storage] не удалось отдать состояние:', (error as Error)?.message || error);
    return NextResponse.json({ error: 'Не удалось проверить Storage' }, { status: 500, ...NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
    // Кнопка перезапускает сервис, к которому в этот момент идут загрузки:
    // случайный POST из чужой вкладки не должен этого делать.
    if (body?.confirm !== true) {
      return NextResponse.json({ error: 'Нужно подтверждение: confirm=true' }, { status: 400, ...NO_STORE });
    }

    const result = await restartStorage();
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, update: result.update },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({ success: true, update: result.update }, { status: 202, ...NO_STORE });
  } catch {
    return NextResponse.json({ error: 'Не удалось запустить перезапуск Storage' }, { status: 500, ...NO_STORE });
  }
}
