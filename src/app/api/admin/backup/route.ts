import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import {
  beginMaintenance,
  endMaintenance,
  readBackupRecord,
  readMaintenanceState,
  reconcileMaintenance,
  watchBackupJob,
} from '@/lib/maintenance';
import { backupDue } from '@/lib/maintenanceFlag';
import { callUpdateAgent, getUpdateAgentStatus } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/** Что видит админ: состояние агента, признак техработ и отметку о копии. */
async function snapshot() {
  // Веб-процесс мог перезапуститься посреди дампа: сначала сверяем признак
  // с агентом, иначе заглушка висела бы до expires_at без причины.
  const maintenance = (await reconcileMaintenance()) ?? (await readMaintenanceState());
  const [status, backup] = await Promise.all([
    getUpdateAgentStatus({ full: true, cacheMs: 0 }),
    readBackupRecord(),
  ]);
  return {
    configured: status.configured,
    connected: status.connected,
    reason: status.reason,
    update: status.update,
    maintenance,
    backup,
    due: backupDue(backup?.lastAt ?? null),
  };
}

/**
 * Ручная резервная копия базы (Админка → Бэкапы).
 *
 * Ритм еженедельный и только ручной: cron-задач на сервере для этого нет.
 * Сам дамп делает приватный update-agent на хосте (`deploy/db-backup.sh`):
 * у контейнера web нет ни Docker-сокета, ни pg_dump, ни доступа к каталогу
 * копий. Пока агент работает, сайт закрыт заглушкой «Ведутся технические
 * работы» — признак ставит этот маршрут, а снимает фоновый опрос агента.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;
    return NextResponse.json({ success: true, ...(await snapshot()) }, NO_STORE);
  } catch (error) {
    console.error('[admin/backup] не удалось отдать статус:', (error as Error)?.message || error);
    return NextResponse.json({ error: 'Не удалось получить статус резервного копирования' }, { status: 500, ...NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = (await request.json().catch(() => null)) as { confirm?: unknown; full?: unknown } | null;
    // Копия закрывает сайт заглушкой — случайный POST не должен этого делать.
    if (body?.confirm !== true) {
      return NextResponse.json({ error: 'Нужно подтверждение: confirm=true' }, { status: 400, ...NO_STORE });
    }
    // Полный дамп включает каталог систем (десятки гигабайт и часы работы),
    // поэтому он возможен только явным флагом.
    const full = body?.full === true;

    const running = await getUpdateAgentStatus({ cacheMs: 0 });
    if (!running.configured) {
      return NextResponse.json(
        { success: false, error: running.reason || 'Update-агент не настроен (UPDATE_AGENT_URL, UPDATE_AGENT_TOKEN)' },
        { status: 503, ...NO_STORE },
      );
    }
    if (running.update?.active) {
      return NextResponse.json(
        {
          success: false,
          error: running.update.kind === 'backup'
            ? 'Резервное копирование уже выполняется'
            : 'Сейчас идёт обновление проекта — дождитесь его окончания',
          update: running.update,
        },
        { status: 409, ...NO_STORE },
      );
    }

    // Сначала заглушка, потом дамп: посетитель не должен увидеть сайт
    // в момент, когда база уже копируется.
    await beginMaintenance(full
      ? 'Резервное копирование базы данных (полный дамп, включая каталог систем)'
      : 'Резервное копирование базы данных');

    const result = await callUpdateAgent('backup', { full });
    if (!result.ok) {
      await endMaintenance();
      return NextResponse.json(
        { success: false, error: result.error, update: 'update' in result ? result.update : null },
        { status: result.status, ...NO_STORE },
      );
    }

    watchBackupJob({ full });
    // snapshot() уже содержит свежий update — вторым полем его не перетираем.
    return NextResponse.json({ success: true, started: result.status === 202, ...(await snapshot()) }, { status: 202, ...NO_STORE });
  } catch (error) {
    console.error('[admin/backup] не удалось запустить копирование:', (error as Error)?.message || error);
    // Сайт не должен остаться под заглушкой из-за ошибки запуска.
    await endMaintenance();
    return NextResponse.json(
      { error: 'Не удалось запустить резервное копирование. Подробности — в закрытых журналах приложения.' },
      { status: 500, ...NO_STORE },
    );
  }
}

/** Прерывает дамп (SIGTERM группе процессов агента) и снимает заглушку. */
export async function DELETE(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const result = await callUpdateAgent('abort');
    await endMaintenance();
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status, ...NO_STORE });
    }
    return NextResponse.json({ success: true, ...(await snapshot()) }, NO_STORE);
  } catch (error) {
    console.error('[admin/backup] не удалось остановить копирование:', (error as Error)?.message || error);
    return NextResponse.json({ error: 'Не удалось остановить резервное копирование' }, { status: 500, ...NO_STORE });
  }
}
