import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { callUpdateAgent, getUpdateAgentStatus } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Admin-only control for the manual project update.
 *
 * The web process never runs git, Docker or a shell: it relays the request to
 * the private host-side update-agent, which is the only process allowed to
 * rebuild the stack. Progress is polled by the panel (`GET`), so a rebuild that
 * replaces the web container itself is not lost — the browser simply
 * reconnects and continues from the persisted state file.
 *
 * `GET` отдаёт ХВОСТ ЖУРНАЛА сборки — он содержит пути, имена контейнеров и
 * сообщения инструментов, поэтому читается только после requireAdmin. Для
 * всех остальных есть публичный /api/status с одной стадией и процентом.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const update = await getUpdateAgentStatus({ full: true, cacheMs: 0 });
    return NextResponse.json({
      success: true,
      configured: update.configured,
      connected: update.connected,
      reason: update.reason,
      update: update.update,
    }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось получить статус обновления' }, { status: 500, ...NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = await request.json().catch(() => null) as {
      applyMigrations?: unknown;
      backup?: unknown;
      runTests?: unknown;
      migrationsOnly?: unknown;
      confirm?: unknown;
    } | null;
    // A rebuild of production must be an explicit action, never a stray POST.
    if (body?.confirm !== true) {
      return NextResponse.json({ error: 'Нужно подтверждение: confirm=true' }, { status: 400, ...NO_STORE });
    }
    // Флажки приходят из панели мониторинга: с тестами / с бэкапом БД /
    // с миграциями, плюс отдельный режим «применить только миграции»
    // (без сборки и переключения контейнеров). Любой флаг — строго boolean:
    // undefined означает «по умолчанию включено».
    const flag = (value: unknown, fallback = true) => (value === undefined ? fallback : value === true);
    const migrationsOnly = body?.migrationsOnly === true;
    const applyMigrations = migrationsOnly ? true : flag(body?.applyMigrations);
    const backup = flag(body?.backup);
    const runTests = flag(body?.runTests);

    const result = await callUpdateAgent('start', { applyMigrations, backup, runTests, migrationsOnly });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, update: 'update' in result ? result.update : null },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({ success: true, update: result.update }, { status: 202, ...NO_STORE });
  } catch {
    console.error('[admin/update] unable to start the updater');
    return NextResponse.json(
      { error: 'Не удалось запустить обновление. Подробности — в закрытых журналах приложения.' },
      { status: 500, ...NO_STORE },
    );
  }
}

/** Stops a running update (SIGTERM to the updater process group). */
export async function DELETE(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const result = await callUpdateAgent('abort');
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status, ...NO_STORE });
    }
    return NextResponse.json({ success: true, update: result.update }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось остановить обновление' }, { status: 500, ...NO_STORE });
  }
}
