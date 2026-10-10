// ═══════════════════════════════════════════════════════════════════
// Единое слияние статистики пилота для досье
// ═══════════════════════════════════════════════════════════════════
//
// Одни и те же параметры досье приходят из двух таблиц:
//
//   • `pilot_stats` — сводка из журналов (загрузка в браузере И Colonial
//     Helper) и из CAPI-синхронизации;
//   • `capi_profiles` — кэш профиля Frontier CAPI (синхронизация сайта).
//
// Раньше слияние было размазано по потребителям и расходилось: страница
// `/cmdr/[name]` брала ранги Combat/Trade/Explore/Impire/Fed и текущее
// положение ТОЛЬКО из `capi_profiles`, а `/api/cmdr/stats` — в первую
// очередь из `pilot_stats`. Для пилота без привязки на сайте (данные принёс
// только Helper со своей CAPI-авторизацией) досье показывало нули и «—»
// при заполненной `pilot_stats`.
//
// Здесь одно правило для обоих потребителей:
//
//   • поля, которые пишет CAPI-синхронизация (кредиты, ранги, корабль,
//     система, станция), берутся из `pilot_stats`, а если их нет — из
//     `capi_profiles`: у `pilot_stats` источники шире (журналы + CAPI
//     хелпера + синхронизация сайта);
//   • счётчики находок и экзобиологии — максимум из обоих источников и
//     прямого подсчёта по `system_scans` (первооткрытия видны, даже когда
//     сами таблицы статистики ещё пусты);
//   • `exploration_stats` склеивается, причём приоритет у `pilot_stats`.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DossierStatsInput {
  pilotStats?: Record<string, any> | null;
  capiProfile?: Record<string, any> | null;
  /** Имя командира из запроса (страница/API ищут досье по имени). */
  cmdrName?: string | null;
  /** Прямой подсчёт первооткрытий по `system_scans`. */
  firstDiscoveredCount?: number | null;
  /** Прямой подсчёт картографий по `system_scans`. */
  firstMappedCount?: number | null;
}

export interface MergedPilotStats {
  cmdr_name: string | null;
  credits: number;
  arx: number;
  mercenary_coins: number;
  mercenary_rank: number;
  exobiologist_rank: number;
  combat_rank: number;
  trade_rank: number;
  explore_rank: number;
  empire_rank: number;
  federation_rank: number;
  current_ship: string | null;
  current_system: string | null;
  current_station: string | null;
  first_discoveries_count: number;
  first_mapped_count: number;
  first_footfalls_count: number;
  bio_samples_count: number;
  bio_species_count: number;
  bio_value_cr: number;
  exploration_stats: Record<string, any>;
  last_updated: string | null;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const maxOf = (...values: unknown[]): number =>
  Math.max(0, ...values.map((value) => num(value ?? 0)));

/**
 * Слить `pilot_stats` и `capi_profiles` в объект, который показывается в
 * досье. Функция намеренно не падает на битых данных: отсутствие значения
 * трактуется как 0/null, чтобы одна пустая строка не гасила весь блок.
 */
export function mergePilotStats(input: DossierStatsInput): MergedPilotStats {
  const { pilotStats, capiProfile } = input;

  return {
    cmdr_name: input.cmdrName ?? pilotStats?.cmdr_name ?? capiProfile?.cmdr_name ?? null,
    credits: num(pilotStats?.credits ?? capiProfile?.credits ?? 0),
    arx: num(pilotStats?.arx ?? capiProfile?.arx ?? 0),
    mercenary_coins: num(pilotStats?.mercenary_coins ?? capiProfile?.mercenary_coins ?? 0),
    mercenary_rank: num(pilotStats?.mercenary_rank ?? capiProfile?.mercenary_rank ?? 0),
    exobiologist_rank: num(pilotStats?.exobiologist_rank ?? capiProfile?.exobiologist_rank ?? 0),
    combat_rank: num(pilotStats?.combat_rank ?? capiProfile?.combat_rank ?? 0),
    trade_rank: num(pilotStats?.trade_rank ?? capiProfile?.trade_rank ?? 0),
    explore_rank: num(pilotStats?.explore_rank ?? capiProfile?.explore_rank ?? 0),
    empire_rank: num(pilotStats?.empire_rank ?? capiProfile?.empire_rank ?? 0),
    federation_rank: num(pilotStats?.federation_rank ?? capiProfile?.federation_rank ?? 0),
    current_ship: pilotStats?.current_ship || capiProfile?.current_ship || null,
    current_system: pilotStats?.current_system || capiProfile?.current_system || null,
    current_station: pilotStats?.current_station || capiProfile?.current_station || null,
    first_discoveries_count: maxOf(
      pilotStats?.first_discoveries_count,
      capiProfile?.first_discoveries_count,
      input.firstDiscoveredCount,
    ),
    first_mapped_count: maxOf(
      pilotStats?.first_mapped_count,
      capiProfile?.first_mapped_count,
      input.firstMappedCount,
    ),
    first_footfalls_count: maxOf(pilotStats?.first_footfalls_count, capiProfile?.first_footfalls_count),
    bio_samples_count: maxOf(pilotStats?.bio_samples_count, capiProfile?.bio_samples_count),
    bio_species_count: maxOf(pilotStats?.bio_species_count, capiProfile?.bio_species_count),
    bio_value_cr: maxOf(pilotStats?.bio_value_cr, capiProfile?.bio_value_cr),
    exploration_stats: {
      ...(capiProfile?.exploration_stats || {}),
      ...(pilotStats?.exploration_stats || {}),
    },
    last_updated: pilotStats?.last_updated || capiProfile?.last_updated || null,
  };
}
