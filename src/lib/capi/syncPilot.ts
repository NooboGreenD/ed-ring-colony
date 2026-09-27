// ═══════════════════════════════════════════════════════════════
// Один синк Frontier CAPI для одного пилота
// ═══════════════════════════════════════════════════════════════
//
// Раньше логика синка была скопирована в трёх местах — `/api/capi/callback`,
// `/api/capi/sync` и `/api/cron/capi-sync` — и все три расходились: колбэк
// не писал журнал, cron не умел `CapiSession` (обновлял токен только перед
// первым вызовом), ручной синк падал целиком, если Frontier отдавал 204 на
// журнал. Теперь путь один.
//
// Главный принцип: **частичный успех — это успех**. Профиль сохранён, а
// журнал за сегодня пуст (командир не играл) или CAPI на техобслуживании —
// это не ошибка привязки, а состояние, о котором надо честно сказать.

import { capiSession, type CapiTokenRow, type RefreshFn } from './session.ts';
import { CapiError, describeCapiError, isUnauthorizedError } from './client.ts';
import { assessProfileBinding, type ProfileBindingStatus } from './profileBinding.ts';
import { capiProfileRow, isBlankProfile, pilotStatsRow } from './profile.ts';
import { upsertResilient, updateResilient, schemaWarning } from './persist.ts';
import { syncMemberLocation } from './locationSync.ts';
import { parseColonisationEvents } from '@/lib/journalParser';
import {
  depotEventRow,
  latestDepotEvents,
  persistColonisationEvents,
  type ColonisationEventRow,
} from '@/lib/colonisationEvents';
import { updateProjectProgress } from '@/lib/projects/autoProgress';

export type JournalStatus = 'ok' | 'empty' | 'partial' | 'error' | 'skipped';

export interface CapiSyncResult {
  ok: boolean;
  cmdrName: string | null;
  profileSaved: boolean;
  journalStatus: JournalStatus;
  eventsImported: number;
  eventsDuplicate: number;
  eventsSkipped: number;
  warnings: string[];
  /** Заполняется, когда провалился сам профиль: синк смысла не имел. */
  error: string | null;
  /** Привязка перестала работать — нужна повторная авторизация пилота. */
  needsReauth: boolean;
  binding: {
    status: ProfileBindingStatus;
    displayName: string | null;
    nameMismatch: boolean;
  };
}

export interface SyncOptions {
  /** Не трогать журнал (быстрая проверка привязки после OAuth). */
  skipJournal?: boolean;
  /** Подмена обновления токена в тестах. */
  refreshFn?: RefreshFn;
  now?: Date;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

/**
 * Синхронизировать одного пилота.
 *
 * Не бросает исключений: любой сбой описан в результате. Это принципиально
 * для cron (одна плохая привязка не должна валить весь проход) и для
 * колбэка OAuth (сбой CAPI не должен отменять уже сохранённую привязку).
 */
export async function syncCapiPilot(
  svc: Svc,
  userId: string,
  tokenRow: CapiTokenRow & { cmdr_name?: string | null },
  options: SyncOptions = {},
): Promise<CapiSyncResult> {
  const now = options.now ?? new Date();
  const warnings: string[] = [];
  const result: CapiSyncResult = {
    ok: false,
    cmdrName: tokenRow.cmdr_name ?? null,
    profileSaved: false,
    journalStatus: options.skipJournal ? 'skipped' : 'error',
    eventsImported: 0,
    eventsDuplicate: 0,
    eventsSkipped: 0,
    warnings,
    error: null,
    needsReauth: false,
    binding: { status: 'missing', displayName: null, nameMismatch: false },
  };

  // ── 1. Сессия и профиль ─────────────────────────────────────────
  let session;
  try {
    session = await capiSession(svc, userId, tokenRow, options.refreshFn);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.needsReauth = true;
    return result;
  }

  let profile;
  try {
    profile = await session.run((client) => client.getProfile());
  } catch (err) {
    result.error = describeCapiError(err);
    result.needsReauth = isUnauthorizedError(err);
    return result;
  }

  const cmdrName = profile.cmdrName ?? tokenRow.cmdr_name ?? null;
  result.cmdrName = cmdrName;

  if (isBlankProfile(profile)) {
    warnings.push('Frontier вернул пустой профиль: командир ещё не заходил в игру после привязки');
  }

  // ── 2. Имя командира в профиле сайта ────────────────────────────
  const { data: siteProfile } = await svc
    .from('profiles')
    .select('cmdr_name')
    .eq('id', userId)
    .maybeSingle();

  const binding = assessProfileBinding(siteProfile?.cmdr_name, cmdrName);
  result.binding = {
    status: binding.status,
    displayName: binding.displayName,
    nameMismatch: binding.nameMismatch,
  };
  // Заполняем только пустой профиль: сохранённый ник — пользовательское
  // значение, CAPI не должен молча переименовать публичное досье.
  if (binding.status === 'linked' && cmdrName) {
    const { error } = await svc.from('profiles').update({ cmdr_name: cmdrName }).eq('id', userId);
    if (error) warnings.push(`Имя CMDR не записано в профиль сайта: ${error.message}`);
  }

  // ── 3. capi_profiles ────────────────────────────────────────────
  const profileWrite = await upsertResilient(
    svc,
    'capi_profiles',
    capiProfileRow(userId, profile, { cmdrNameFallback: tokenRow.cmdr_name, now }),
    { onConflict: 'user_id' },
  );
  const profileSchemaWarning = schemaWarning('capi_profiles', profileWrite.droppedColumns);
  if (profileSchemaWarning) warnings.push(profileSchemaWarning);

  if (!profileWrite.ok) {
    result.error = `Не удалось сохранить профиль Frontier: ${profileWrite.error?.message ?? 'unknown error'}`;
    return result;
  }
  result.profileSaved = true;

  // ── 4. pilot_stats: витрина досье и рейтингов ───────────────────
  // Досье (/cmdr/<name>) читает pilot_stats в первую очередь, поэтому синк
  // CAPI обязан наполнять и её — иначе «данные не подтягиваются» ровно там,
  // где пилот их ищет.
  const statsWrite = await upsertResilient(
    svc,
    'pilot_stats',
    pilotStatsRow(userId, profile, { cmdrNameFallback: tokenRow.cmdr_name, now }),
    { onConflict: 'user_id' },
  );
  if (!statsWrite.ok) {
    warnings.push(`Статистика пилота не обновлена: ${statsWrite.error?.message ?? 'unknown error'}`);
  }

  // ── 5. Положение в эскадрилье ───────────────────────────────────
  // Передаём уже полученный профиль: второй запрос `/profile` только жёг бы
  // лимит Frontier ради тех же данных.
  try {
    await syncMemberLocation(userId, profile);
  } catch (err) {
    warnings.push(`Положение в эскадрилье не обновлено: ${describeCapiError(err)}`);
  }

  // ── 6. Журнал и события колонизации ─────────────────────────────
  if (!options.skipJournal) {
    try {
      const journal = await session.run((client) => client.getJournal());

      if (journal.partial) {
        result.journalStatus = 'partial';
        warnings.push('Frontier отдал журнал частично (HTTP 206) — повторите синхронизацию позже');
      } else if (journal.empty) {
        result.journalStatus = 'empty';
      } else {
        result.journalStatus = 'ok';
      }
      if (journal.malformedLines > 0) {
        warnings.push(`Пропущено нечитаемых строк журнала: ${journal.malformedLines}`);
      }

      if (journal.text) {
        const events = parseColonisationEvents(journal.text);
        const rows = events.depotEvents
          .map((ev) => depotEventRow(userId, ev))
          .filter((row): row is ColonisationEventRow => row !== null);

        const write = await persistColonisationEvents(svc, rows);
        warnings.push(...write.warnings);
        result.eventsImported = write.inserted;
        result.eventsDuplicate = write.duplicates;
        result.eventsSkipped = events.depotEvents.length - rows.length;

        // Прогресс проекта — по последнему состоянию каждой стройки: окно
        // CAPI на каждом синке содержит одни и те же события.
        for (const ev of latestDepotEvents(events.depotEvents)) {
          try {
            await updateProjectProgress(ev.systemName, ev.constructionProgress, ev.resourcesRequired, 'capi');
          } catch (err) {
            warnings.push(`Прогресс ${ev.systemName} не обновлён: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      result.journalStatus = 'error';
      if (err instanceof CapiError && err.kind === 'no_content') {
        result.journalStatus = 'empty';
      } else {
        // Журнал — не привязка: профиль уже сохранён, синк считается удачным.
        warnings.push(`Журнал CAPI не получен: ${describeCapiError(err)}`);
        if (isUnauthorizedError(err)) result.needsReauth = true;
      }
    }
  }

  // ── 7. Отметка успешного синка ──────────────────────────────────
  const tokenUpdate = await updateResilient(
    svc,
    'capi_tokens',
    {
      last_synced_at: now.toISOString(),
      cmdr_name: cmdrName,
      is_active: true,
      last_error: null,
    },
    { column: 'user_id', value: userId },
  );
  if (!tokenUpdate.ok) {
    warnings.push(`Отметка синхронизации не сохранена: ${tokenUpdate.error?.message ?? 'unknown error'}`);
  }

  result.ok = true;
  return result;
}

/**
 * Пометить привязку сломанной, чтобы интерфейс попросил авторизоваться
 * заново, а cron не долбился в заведомо мёртвый refresh-токен.
 */
export async function markCapiTokenBroken(svc: Svc, userId: string, reason: string): Promise<void> {
  await updateResilient(
    svc,
    'capi_tokens',
    {
      is_active: false,
      last_error: reason.slice(0, 500),
      last_error_at: new Date().toISOString(),
    },
    { column: 'user_id', value: userId },
  );
}
