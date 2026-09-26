/**
 * Сигналы на телах системы: биология, геология, следы людей и «гости».
 *
 * Игра сообщает их событиями `FSSBodySignals` (обзорное сканирование) и
 * `SAASignalsFound` (подробная картография). Раньше сайт считал только
 * биологию — а планировщику колонии важны и остальные: геологические точки
 * дают материалы, человеческие сигналы означают чужое присутствие рядом со
 * стройкой, сигналы стражей и таргоидов — причину выбрать другое тело.
 *
 * Модуль намеренно без React, без сети и без three.js: его читает разбор
 * журнала, каталог тел, планировщик и обе карты (сайт и приложение).
 */

/** Вид сигнала. `other` — всё, что игра не отнесла к известным типам. */
export type SignalKind = 'bio' | 'geo' | 'human' | 'thargoid' | 'guardian' | 'other';

export const SIGNAL_KINDS: SignalKind[] = ['bio', 'geo', 'human', 'thargoid', 'guardian', 'other'];

/** Счётчики сигналов тела + роды биологии, если их уже определили. */
export interface BodySignals {
  bio: number;
  geo: number;
  human: number;
  thargoid: number;
  guardian: number;
  other: number;
  /** Роды организмов из `SAASignalsFound.Genuses` (локализованные имена). */
  genuses: string[];
}

export const EMPTY_SIGNALS: BodySignals = {
  bio: 0, geo: 0, human: 0, thargoid: 0, guardian: 0, other: 0, genuses: [],
};

/** Как сигнал показывается человеку: подпись, значок и цвет метки. */
export const SIGNAL_META: Record<SignalKind, { label: string; short: string; icon: string; color: string }> = {
  bio: { label: 'биологические сигналы', short: 'био', icon: '🌿', color: '#22c55e' },
  geo: { label: 'геологические сигналы', short: 'гео', icon: '🌋', color: '#e67e22' },
  human: { label: 'следы людей', short: 'люди', icon: '🛰', color: '#4dabf7' },
  thargoid: { label: 'сигналы таргоидов', short: 'таргоиды', icon: '👾', color: '#b197fc' },
  guardian: { label: 'сигналы стражей', short: 'стражи', icon: '🔷', color: '#20c997' },
  other: { label: 'прочие сигналы', short: 'прочее', icon: '❔', color: '#adb5bd' },
};

/**
 * Определить вид сигнала по типу из журнала.
 *
 * Игра присылает либо служебный ключ (`$SAA_SignalType_Biological;`), либо
 * его локализованный перевод — учитываем оба, включая русский клиент.
 */
export function classifySignal(type: string | null | undefined): SignalKind {
  const value = String(type ?? '').toLowerCase();
  if (!value) return 'other';
  if (value.includes('biolog') || value.includes('биолог')) return 'bio';
  if (value.includes('geolog') || value.includes('геолог')) return 'geo';
  if (value.includes('thargoid') || value.includes('таргоид')) return 'thargoid';
  if (value.includes('guardian') || value.includes('страж')) return 'guardian';
  if (value.includes('human') || value.includes('человеч') || value.includes('люд')) return 'human';
  return 'other';
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(999, Math.round(parsed)) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Сложить два набора сигналов, взяв по каждому виду большее значение. */
export function mergeSignals(left: BodySignals | null | undefined, right: BodySignals | null | undefined): BodySignals {
  const a = left ?? EMPTY_SIGNALS;
  const b = right ?? EMPTY_SIGNALS;
  return {
    bio: Math.max(a.bio, b.bio),
    geo: Math.max(a.geo, b.geo),
    human: Math.max(a.human, b.human),
    thargoid: Math.max(a.thargoid, b.thargoid),
    guardian: Math.max(a.guardian, b.guardian),
    other: Math.max(a.other, b.other),
    genuses: Array.from(new Set([...a.genuses, ...b.genuses])),
  };
}

/**
 * Разобрать список сигналов события журнала (`Signals: [{Type, Count}]`).
 *
 * Понимает и уже собранный список `[{type, count}]` из базы: помощник
 * присылает его как есть.
 */
export function signalsFromList(list: unknown, genuses: unknown = null): BodySignals {
  const result: BodySignals = { ...EMPTY_SIGNALS, genuses: [] };
  if (Array.isArray(list)) {
    for (const entry of list) {
      const record = asRecord(entry);
      if (!record) continue;
      const type = `${record.Type ?? record.type ?? ''} ${record.Type_Localised ?? record.type_localised ?? ''}`;
      const kind = classifySignal(type);
      result[kind] += count(record.Count ?? record.count ?? 1);
    }
  }
  if (Array.isArray(genuses)) {
    const names = genuses
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        const record = asRecord(entry);
        if (!record) return '';
        return String(record.Genus_Localised ?? record.genus_localised ?? record.Genus ?? record.genus ?? '').trim();
      })
      .filter(Boolean);
    result.genuses = Array.from(new Set(names)).slice(0, 24);
  }
  return result;
}

/**
 * Достать сигналы из строки каталога тел (`system_scans`) или любой похожей
 * записи: колонки `*_signals_count`, список `signals` и старое поле
 * `bio_signals_count` (записи до появления остальных видов).
 */
export function signalsFromRecord(row: unknown): BodySignals {
  const record = asRecord(row);
  if (!record) return { ...EMPTY_SIGNALS };
  const raw = asRecord(record.raw_data) ?? asRecord(record.rawData);
  const fromList = signalsFromList(
    record.signals ?? raw?.signals ?? raw?.Signals ?? null,
    record.bio_genuses ?? record.bioGenuses ?? raw?.Genuses ?? null,
  );
  const explicit: BodySignals = {
    bio: count(record.bio_signals_count ?? record.bio_signals ?? record.bioSignals ?? record.bioSignalsCount),
    geo: count(record.geo_signals_count ?? record.geo_signals ?? record.geoSignals),
    human: count(record.human_signals_count ?? record.human_signals ?? record.humanSignals),
    thargoid: count(record.thargoid_signals_count ?? record.thargoid_signals ?? record.thargoidSignals),
    guardian: count(record.guardian_signals_count ?? record.guardian_signals ?? record.guardianSignals),
    other: count(record.other_signals_count ?? record.other_signals ?? record.otherSignals),
    genuses: [],
  };
  return mergeSignals(fromList, explicit);
}

/** Сколько всего сигналов на теле (для сводок и фильтра «есть сигналы»). */
export function totalSignals(signals: BodySignals | null | undefined): number {
  if (!signals) return 0;
  return SIGNAL_KINDS.reduce((sum, kind) => sum + (signals[kind] || 0), 0);
}

/** Есть ли хоть один сигнал. */
export function hasSignals(signals: BodySignals | null | undefined): boolean {
  return totalSignals(signals) > 0;
}

/** Виды сигналов с ненулевым счётчиком — в порядке важности для колонии. */
export function activeSignalKinds(signals: BodySignals | null | undefined): SignalKind[] {
  if (!signals) return [];
  return SIGNAL_KINDS.filter((kind) => (signals[kind] || 0) > 0);
}

/** Строка для подсказки: «био 3 · гео 2 · люди 1». */
export function describeSignals(signals: BodySignals | null | undefined): string {
  return activeSignalKinds(signals)
    .map((kind) => `${SIGNAL_META[kind].short} ${signals![kind]}`)
    .join(' · ');
}

/** Колонки каталога тел: обратная запись сигналов в строку `system_scans`. */
export function signalsToColumns(signals: BodySignals): Record<string, unknown> {
  return {
    bio_signals_count: signals.bio,
    geo_signals_count: signals.geo,
    human_signals_count: signals.human,
    thargoid_signals_count: signals.thargoid,
    guardian_signals_count: signals.guardian,
    other_signals_count: signals.other,
    bio_genuses: signals.genuses,
  };
}
