/**
 * Сброс всех журнальных данных пользователя перед повторной загрузкой с нуля.
 *
 * Повторная загрузка журнала с нуля нужна, когда в базе накопились мусорные
 * части логов (оборванные импорты, старые схемы, неконсистентные повторы).
 * Простое «залить поверх» не поможет: идемпотентные ключи deliveries не
 * чистят мусор, а снимки строек и сканы тел остаются от старых прогонов.
 *
 * Сбрасываются ТОЛЬКО данные, которые принадлежат пользователю:
 *   • deliveries                     — все поставки
 *   • journal_imports                — история импортов
 *   • colonisation_events            — устаревшая таблица событий стройки
 *   • pilot_stats                    — сводка пилота (кредиты, ранги, жетоны)
 *   • system_scans                   — сканы тел, которые загрузил этот пользователь
 *
 * Общие таблицы (доступны другим командирам) мы НЕ удаляем:
 *   • colonisation_sites             — текущее состояние площадок (общая карта);
 *                                      у строк этого пользователя просто снимаем
 *                                      авторство (user_id → NULL), чтобы не
 *                                      блокировать перезапись более старыми
 *                                      timestamp'ами после реимпорта.
 *   • construction_depot_snapshots   — история прогресса общедоступна и не
 *                                      привязана к пользователю. Сносить её
 *                                      значило бы ломать графики Raven для
 *                                      всех остальных. Пользовательский реимпорт
 *                                      сам не добавит лишних строк: дедупликация
 *                                      в journalTelemetry сверяет снимки по ключу.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface JournalResetOutcome {
  /** Сколько поставок удалено. */
  deliveriesDeleted: number;
  /** Сколько записей об импортах журналов удалено. */
  journalImportsDeleted: number;
  /** Сколько устаревших colonisation_events удалено. */
  legacyEventsDeleted: number;
  /** Сброшена ли строка pilot_stats (true — строка удалена). */
  pilotStatsDeleted: boolean;
  /** Сколько сканов тел удалено (только тех, где user_id совпадал). */
  systemScansDeleted: number;
  /** Сколько строк colonisation_sites лишились авторства (user_id → NULL). */
  sitesDetached: number;
}

/**
 * Размер одной пачки на DELETE. Неограниченный DELETE по user_id на таблице
 * с миллионами строк может упереться в statement_timeout — режем так же, как
 * и записи импорта.
 */
const RESET_BATCH_SIZE = 500;

async function deleteInBatches(
  svc: SupabaseClient,
  table: 'deliveries' | 'journal_imports' | 'colonisation_events' | 'system_scans',
  userId: string,
  filter: (q: any) => any = (q) => q,
): Promise<number> {
  let total = 0;
  for (let guard = 0; guard < 20_000; guard += 1) {
    // Сначала выбираем порцию на удаление, потом удаляем по первичному ключу.
    // Прямой .delete().eq('user_id', userId).limit(N) в PostgREST не поддерживается,
    // а без лимита один большой DELETE рискует таймаутом на большой таблице.
    const selectColumns = table === 'journal_imports' ? 'id' : 'id';
    const { data, error: selectError } = await filter(
      svc.from(table).select(selectColumns).eq('user_id', userId).limit(RESET_BATCH_SIZE),
    );
    if (selectError) throw new Error(`${table} select for reset: ${selectError.message}`);
    const rows = Array.isArray(data) ? data as Array<{ id: number }> : [];
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const { error: deleteError } = await svc.from(table).delete().in('id', ids);
    if (deleteError) throw new Error(`${table} delete for reset: ${deleteError.message}`);
    total += ids.length;
    if (rows.length < RESET_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Сбросить все журнальные данные пользователя.
 *
 * @param svc        клиент Supabase с правами service_role
 * @param userId     идентификатор профиля
 * @param options    набор секций для очистки — позволяет очистить только
 *                   часть данных, если пользователь уже импортировал что-то
 *                   другое вручную (например, не хочет терять сканы тел).
 */
export async function resetJournalData(
  svc: SupabaseClient,
  userId: string,
  options: {
    deliveries?: boolean;
    imports?: boolean;
    legacyEvents?: boolean;
    pilotStats?: boolean;
    systemScans?: boolean;
    detachSites?: boolean;
  } = {},
): Promise<JournalResetOutcome> {
  const {
    deliveries = true,
    imports = true,
    legacyEvents = true,
    pilotStats = true,
    systemScans = true,
    detachSites = true,
  } = options;

  const outcome: JournalResetOutcome = {
    deliveriesDeleted: 0,
    journalImportsDeleted: 0,
    legacyEventsDeleted: 0,
    pilotStatsDeleted: false,
    systemScansDeleted: 0,
    sitesDetached: 0,
  };

  // Поставки — самая большая таблица; пачками, с лимитом.
  if (deliveries) {
    outcome.deliveriesDeleted = await deleteInBatches(svc, 'deliveries', userId);
  }

  // История импортов журналов (для страницы «журнал CMDR»).
  if (imports) {
    outcome.journalImportsDeleted = await deleteInBatches(svc, 'journal_imports', userId);
  }

  // Устаревшая таблица colonisation_events — в новых версиях не пишется
  // (см. комментарий в /api/journal/import), но мусор в ней остаётся у
  // пользователей, которые грузили логи год назад.
  if (legacyEvents) {
    outcome.legacyEventsDeleted = await deleteInBatches(svc, 'colonisation_events', userId);
  }

  // Сводка пилота (кредиты, ранги, жетоны, биооткрытия). Перезапишется
  // первым же LoadGame из нового журнала.
  if (pilotStats) {
    const { error: statsError } = await svc
      .from('pilot_stats')
      .delete()
      .eq('user_id', userId);
    if (statsError) throw new Error(`pilot_stats delete: ${statsError.message}`);
    outcome.pilotStatsDeleted = true;
  }

  // Сканы тел — уникальны по паре (система, тело) и имеют user_id того,
  // кто последним обновлял запись. Удаляем только свои: общие сканы, которые
  // дополнил другой пилот, не трогаем.
  if (systemScans) {
    outcome.systemScansDeleted = await deleteInBatches(svc, 'system_scans', userId);
  }

  // Состояния стройплощадок (общая карта) не удаляем — это видно всем
  // командирам. Снимаем авторство у строк, которые обновляли мы: после этого
  // первый же snapshot при повторном импорте сможет перезаписать строку,
  // даже если его timestamp окажется старше «нашего» последнего состояния.
  if (detachSites) {
    // Одним UPDATE: это не DELETE, и выборка по user_id в colonisation_sites
    // не ожидается большой (один пользователь может быть «последним автором»
    // максимум у нескольких сотен площадок).
    const { data, error: detachError } = await svc
      .from('colonisation_sites')
      .update({ user_id: null }, { count: 'exact' })
      .eq('user_id', userId)
      .select('market_id');
    if (detachError) throw new Error(`colonisation_sites detach: ${detachError.message}`);
    outcome.sitesDetached = Array.isArray(data) ? data.length : 0;
  }

  return outcome;
}
