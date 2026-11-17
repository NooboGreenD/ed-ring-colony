/**
 * Эскадрилья пилота из журнала игры: приём и раскладка по местам.
 *
 * Источник — `SquadronStartup` (при каждом запуске игры) и
 * `SquadronPromotion` (при повышении). Colonial Helper отгружает их в
 * `POST /api/cmdr/squadron`, загрузчик журналов в браузере передаёт ту же
 * пачку в `/api/logs/import`.
 *
 * Раскладка одна и живёт в SQL (`apply_pilot_squadron`, миграция
 * `20261117090000_squadron_journal_sync.sql`): профиль пилота
 * (`profiles.game_squadron_*`), связь эскадрильи сайта с игровой
 * (`squadrons.game_squadron_id`), состав (`squadron_members`) и игровой ранг.
 * Здесь — только проверка входных данных: функция доступна исключительно
 * `service_role`, поэтому мусор с клиента до неё доходить не должен.
 */

type Svc = any;

export interface SquadronReport {
  /** SquadronID из журнала. */
  gameSquadronId: number;
  /** SquadronName: имя может прийти пустым (пилот в эскадрилье без имени). */
  gameSquadronName: string;
  /** `SquadronTag`, если журнал его принёс (в событиях он необязателен). */
  gameSquadronTag: string | null;
  /** CurrentRank / NewRank. `null` — ранг неизвестен. */
  gameRank: number | null;
  /**
   * Имя игрового ранга, если его назвал клиент (`SquadronPromotion` его не
   * содержит — только число). По имени сайт подбирает своё звание.
   */
  gameRankName: string | null;
  /** Время журнального события: по нему старый журнал не откатывает свежий. */
  eventAt: string | null;
}

export interface SquadronApplyResult {
  ok: boolean;
  gameSquadronId: number | null;
  gameSquadronName: string | null;
  gameRank: number | null;
  /** Эскадрилья сайта, к которой приписан пилот (null — не нашлась). */
  squadronId: number | null;
  squadronName: string | null;
  foundBy: string | null;
  member: boolean;
  joined: boolean;
  /** Сайт завёл эскадрилью по журналу: раньше её здесь не было. */
  created: boolean;
  rankId: number | null;
  rankName: string | null;
  reason: string | null;
  skipped: string | null;
  at: string | null;
}

const MAX_NAME = 120;
const MAX_TAG = 10;
const MAX_RANK_NAME = 80;
const MAX_GAME_RANK = 20;

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function rankOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rank = Math.trunc(parsed);
  return rank >= 0 && rank <= MAX_GAME_RANK ? rank : null;
}

function isoAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Разбор того, что прислал клиент. Поддерживаются оба написания полей
 * (`game_squadron_id` от Helper'а и `gameSquadronId` в ответах маршрутов).
 */
export function parseSquadronReport(body: Record<string, unknown>): SquadronReport | null {
  const id = positiveInt(body.game_squadron_id ?? body.gameSquadronId ?? body.squadronId);
  if (!id) return null;
  return {
    gameSquadronId: id,
    gameSquadronName: text(body.game_squadron_name ?? body.gameSquadronName, MAX_NAME),
    gameSquadronTag: text(body.game_squadron_tag ?? body.gameSquadronTag, MAX_TAG) || null,
    gameRank: rankOf(body.game_squadron_rank ?? body.gameSquadronRank ?? body.gameRank ?? body.rank),
    gameRankName: text(body.game_squadron_rank_name ?? body.gameRankName, MAX_RANK_NAME) || null,
    eventAt: isoAt(body.event_at ?? body.eventAt ?? body.timestamp),
  };
}

/** Состояние из одной строки журнала (`SquadronStartup`/`SquadronPromotion`). */
export function squadronReportFromEvent(event: Record<string, unknown>): SquadronReport | null {
  const name = String(event.event ?? '');
  if (name !== 'SquadronStartup' && name !== 'SquadronPromotion') return null;
  return parseSquadronReport({
    gameSquadronId: event.SquadronID,
    gameSquadronName: event.SquadronName,
    gameSquadronTag: event.SquadronTag ?? event.Tag,
    // У повышения ранг лежит в NewRank: CurrentRank пишется и в старом, и в
    // новом событии, но у `SquadronPromotion` его может не быть вовсе.
    gameRank: name === 'SquadronPromotion' ? event.NewRank : event.CurrentRank,
    gameRankName: event.RankName ?? event.SquadronRank,
    eventAt: event.timestamp,
  });
}

/**
 * Применить сведения об эскадрилье к сайту.
 *
 * `join` — автовступление в состав (по умолчанию включено). Ошибка базы не
 * глотается: вызывающий маршрут решает, что делать. Отсутствие функции в базе
 * (миграция ещё не накатана) отличается от прочих сбоев — см. `schemaOutdated`.
 */
export async function applyPilotSquadron(
  svc: Svc,
  userId: string,
  report: SquadronReport,
  options: { source?: 'helper' | 'web' | 'manual'; join?: boolean } = {},
): Promise<SquadronApplyResult> {
  const { data, error } = await svc.rpc('apply_pilot_squadron', {
    p_user: userId,
    p_game_id: report.gameSquadronId,
    p_name: report.gameSquadronName,
    p_tag: report.gameSquadronTag,
    p_rank: report.gameRank,
    p_rank_name: report.gameRankName,
    p_at: report.eventAt ?? new Date().toISOString(),
    p_source: options.source ?? 'helper',
    p_join: options.join !== false,
  });
  if (error) throw new SquadronApplyError(error.message ?? 'apply_pilot_squadron failed', error);
  return normaliseResult(data);
}

export class SquadronApplyError extends Error {
  /** Причина — отсутствие функции/колонок в базе, а не ошибка данных. */
  readonly schemaOutdated: boolean;
  constructor(message: string, error?: { code?: string | null; message?: string | null }) {
    super(message);
    const code = String(error?.code ?? '');
    const text = `${message} ${error?.message ?? ''}`.toLowerCase();
    this.schemaOutdated = code === '42883' || code === 'PGRST202'
      || text.includes('could not find the function')
      || text.includes('does not exist');
  }
}

function normaliseResult(data: unknown): SquadronApplyResult {
  const row = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const int = (value: unknown): number | null => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  };
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    ok: row.ok !== false,
    gameSquadronId: int(row.gameSquadronId),
    gameSquadronName: str(row.gameSquadronName),
    gameRank: int(row.gameRank),
    squadronId: int(row.squadronId),
    squadronName: str(row.squadronName),
    foundBy: str(row.foundBy),
    member: row.member === true,
    joined: row.joined === true,
    created: row.created === true,
    rankId: int(row.rankId),
    rankName: str(row.rankName),
    reason: str(row.reason),
    skipped: str(row.skipped),
    at: str(row.at),
  };
}

/**
 * Сведения об эскадрилье, которые Helper и сайт показывают в карточке пилота.
 * Общая форма для `/api/cmdr/squadron` (GET) и `/api/squadrons/my`.
 */
export interface PilotGameSquadron {
  gameSquadronId: number | null;
  gameSquadronName: string | null;
  gameRank: number | null;
  gameRankName: string | null;
  syncedAt: string | null;
  /** Эскадрилья сайта, если пилот приписан к ней журналом. */
  siteSquadronId: number | null;
  siteSquadronName: string | null;
  source: string | null;
}

export function pilotGameSquadronFromProfile(profile: Record<string, unknown> | null | undefined): PilotGameSquadron {
  const row = profile ?? {};
  const int = (value: unknown): number | null => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  };
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    gameSquadronId: int(row.game_squadron_id),
    gameSquadronName: str(row.game_squadron_name),
    gameRank: int(row.game_squadron_rank),
    gameRankName: str(row.game_squadron_rank_name),
    syncedAt: str(row.game_squadron_at),
    siteSquadronId: int(row.game_squadron_site_id),
    siteSquadronName: null,
    source: str(row.game_squadron_source),
  };
}
