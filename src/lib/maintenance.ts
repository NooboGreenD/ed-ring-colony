/**
 * Технические работы и отметка о последней копии БД (серверная сторона).
 *
 * Признак живёт в `public.app_flags`, а не в памяти процесса:
 *  - заглушку отдаёт прокси (edge-рантайм), который переменные Node не видит;
 *  - контейнер web может перезапуститься посреди дампа — тогда флаг с
 *    `expires_at` отпустит сайт сам, а панель снимет его при следующем опросе.
 *
 * Запись идёт сервисным ключом (обходит RLS), чтение разрешено всем — поэтому
 * прокси обходится анонимным ключом и не таскает секретов в edge-рантайм.
 */
import {
  DB_BACKUP_KEY,
  MAINTENANCE_KEY,
  MAINTENANCE_MAX_MS,
  maintenanceValue,
  mergeBackupRecord,
  parseBackupRecord,
  parseMaintenanceState,
  type BackupRecord,
  type MaintenanceState,
} from './maintenanceFlag';
import { supabaseAdmin } from './supabaseAdmin';
import { getUpdateAgentStatus } from './updateAgent';

/** Как часто опрашивать агент, пока идёт дамп. */
const WATCH_POLL_MS = 5_000;
/**
 * Сколько подряд недоступных агентов мы терпим, прежде чем перестать опрашивать:
 * агент могли перезапустить, и тогда сайт отпускает `expires_at`, а не опрос.
 */
const WATCH_MAX_MISSES = 24;

async function readFlag(key: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin.from('app_flags').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  const value = (data as { value?: unknown } | null)?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function writeFlag(key: string, value: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('app_flags')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function deleteFlag(key: string): Promise<void> {
  const { error } = await supabaseAdmin.from('app_flags').delete().eq('key', key);
  if (error) throw error;
}

/** Признак техработ. `null` — флага нет в таблице. */
export async function readMaintenanceState(now: number = Date.now()): Promise<MaintenanceState | null> {
  try {
    return parseMaintenanceState(await readFlag(MAINTENANCE_KEY), now);
  } catch (error) {
    // Чтение флага не должно ронять запрос: считаем, что техработ нет.
    console.error('[maintenance] не удалось прочитать признак:', (error as Error)?.message || error);
    return null;
  }
}

/** Включает заглушку. Возвращает записанное значение (с `expiresAt`). */
export async function beginMaintenance(reason: string, ttlMs: number = MAINTENANCE_MAX_MS): Promise<MaintenanceState> {
  const value = maintenanceValue(reason, Date.now(), ttlMs);
  await writeFlag(MAINTENANCE_KEY, value);
  return { active: true, reason: value.reason, startedAt: value.startedAt, expiresAt: value.expiresAt };
}

/** Снимает заглушку. Отсутствие флага — не ошибка. */
export async function endMaintenance(): Promise<void> {
  try {
    await deleteFlag(MAINTENANCE_KEY);
  } catch (error) {
    console.error('[maintenance] не удалось снять признак:', (error as Error)?.message || error);
  }
}

/** Отметка о последней копии (в том числе о неудачной попытке). */
export async function readBackupRecord(): Promise<BackupRecord | null> {
  try {
    return parseBackupRecord(await readFlag(DB_BACKUP_KEY));
  } catch (error) {
    console.error('[backup] не удалось прочитать отметку о копии:', (error as Error)?.message || error);
    return null;
  }
}

/**
 * Обновляет отметку о копии. `lastAt` сдвигается только при успехе: неудачная
 * попытка не должна делать вид, что недельный ритм соблюдён.
 */
export async function writeBackupRecord(update: {
  result: 'succeeded' | 'failed' | 'aborted';
  file?: string | null;
  bytes?: number | null;
  full?: boolean;
  error?: string | null;
}): Promise<BackupRecord | null> {
  const previous = await readBackupRecord();
  const value = mergeBackupRecord(previous, update) as unknown as Record<string, unknown>;
  try {
    await writeFlag(DB_BACKUP_KEY, value);
  } catch (error) {
    console.error('[backup] не удалось записать отметку о копии:', (error as Error)?.message || error);
  }
  return parseBackupRecord(value);
}

let watcher: ReturnType<typeof setTimeout> | null = null;

/** Останавливает фоновый опрос агента (нужно в тестах и при отмене). */
export function stopBackupWatcher(): void {
  if (watcher) clearTimeout(watcher);
  watcher = null;
}

/**
 * Дожидается конца дампа и снимает заглушку.
 *
 * Веб-процесс не может держать HTTP-запрос открытым на всё время копии
 * (полный дамп каталога идёт часы), поэтому запрос админа только запускает
 * агент, а завершение дожидаемся здесь. Если процесс перезапустится, опрос
 * потеряется — тогда сайт отпускает `expires_at`, а панель снимает флаг при
 * следующем опросе статуса (`reconcileMaintenance`).
 */
export function watchBackupJob(options: { full: boolean }): void {
  stopBackupWatcher();
  let misses = 0;

  const tick = async () => {
    watcher = null;
    try {
      const status = await getUpdateAgentStatus({ cacheMs: 0 });
      if (!status.connected || !status.update) {
        misses += 1;
        if (misses >= WATCH_MAX_MISSES) {
          console.error('[backup] агент недоступен — заглушку снимет expires_at');
          return;
        }
      } else if (!status.update.active) {
        const update = status.update;
        const result = update.state === 'succeeded' ? 'succeeded' : update.state === 'aborted' ? 'aborted' : 'failed';
        await writeBackupRecord({
          result,
          file: update.backupFile,
          bytes: update.backupBytes,
          full: options.full,
          error: update.error,
        });
        await endMaintenance();
        return;
      }
    } catch (error) {
      console.error('[backup] опрос агента не удался:', (error as Error)?.message || error);
    }
    watcher = setTimeout(tick, WATCH_POLL_MS);
  };

  watcher = setTimeout(tick, WATCH_POLL_MS);
}

/**
 * Сверяет признак с реальностью: если агент свободен, а заглушка висит
 * (веб-процесс перезапустился посреди дампа) — снимаем её.
 */
export async function reconcileMaintenance(): Promise<MaintenanceState | null> {
  const flag = await readMaintenanceState();
  if (!flag?.active) return flag;
  const status = await getUpdateAgentStatus({ cacheMs: 0 });
  if (!status.connected) return flag;
  if (status.update?.active) return flag;
  await writeBackupRecord({
    result: 'failed',
    error: 'веб-процесс перезапустился во время копирования — результат копии неизвестен',
  });
  await endMaintenance();
  return null;
}
