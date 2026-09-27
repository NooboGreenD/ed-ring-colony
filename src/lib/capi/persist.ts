// ═══════════════════════════════════════════════════════════════
// Запись данных CAPI в Supabase, устойчивая к отставшей схеме
// ═══════════════════════════════════════════════════════════════
//
// Зачем
// -----
// Миграции применяются отдельным шагом обновления (`UPDATE_APPLY_MIGRATIONS`
// в deploy/update-project.sh), и на живых стендах база регулярно отстаёт от
// кода. Для CAPI это било по самому больному месту: `capi_profiles` получил
// `cqc_rank`, `loan`, `frontier_id` миграцией 20261002000000, и на базе без
// неё PostgREST отвечал
//
//   PGRST204: Could not find the 'loan' column of 'capi_profiles'
//             in the schema cache
//
// Весь upsert отваливался целиком. Внешне это выглядело ровно как жалоба
// «все этапы проходят, а привязка не делается»: OAuth отработал, токен
// сохранён, профиль — нет, интерфейс показывает «не подключено».
//
// Здесь запись повторяется без тех колонок, которых в базе нет, а список
// выброшенного возвращается предупреждением — его видно и в ответе API, и
// в логах, так что расхождение схемы больше не молчаливое.

/** Ошибка PostgREST в том виде, в каком её отдаёт supabase-js. */
export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

const MISSING_COLUMN_PATTERNS: RegExp[] = [
  // PostgREST >= 9: схема-кэш
  /could not find the '([^']+)' column/i,
  // Postgres 42703 напрямую
  /column "([^"]+)" of relation "[^"]+" does not exist/i,
  /column ([a-z0-9_]+) of relation "[^"]+" does not exist/i,
];

/** Имя колонки, которой нет в базе, или null — если ошибка про другое. */
export function missingColumnFromError(error: PostgrestLikeError | null | undefined): string | null {
  if (!error) return null;
  const haystack = [error.message, error.details, error.hint].filter(Boolean).join(' ');
  if (!haystack) return null;

  for (const pattern of MISSING_COLUMN_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Минимум от Supabase-клиента: описан структурно ради тестовых заглушек. */
export interface ResilientTable {
  upsert(
    values: Record<string, unknown>,
    options?: { onConflict?: string },
  ): PromiseLike<{ error: PostgrestLikeError | null }>;
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): PromiseLike<{ error: PostgrestLikeError | null }>;
  };
}

export interface ResilientClient {
  from(table: string): ResilientTable;
}

export interface WriteOutcome {
  ok: boolean;
  /** Колонки, которых не оказалось в базе: схема отстала от кода. */
  droppedColumns: string[];
  error: PostgrestLikeError | null;
}

/** Сколько раз подряд готовы выбросить «лишнюю» колонку, прежде чем сдаться. */
const MAX_COLUMN_RETRIES = 12;

/**
 * Upsert, который переживает отсутствие новых колонок в базе.
 *
 * Ключевые поля (`user_id` и то, что указано в `required`) не выбрасываются
 * никогда: без них запись бессмысленна, и лучше честно вернуть ошибку.
 */
export async function upsertResilient(
  svc: ResilientClient,
  table: string,
  row: Record<string, unknown>,
  options: { onConflict?: string; required?: string[] } = {},
): Promise<WriteOutcome> {
  const required = new Set(['user_id', ...(options.required ?? [])]);
  const payload: Record<string, unknown> = { ...row };
  const droppedColumns: string[] = [];

  for (let attempt = 0; attempt <= MAX_COLUMN_RETRIES; attempt += 1) {
    const { error } = await svc
      .from(table)
      .upsert(payload, options.onConflict ? { onConflict: options.onConflict } : undefined);

    if (!error) return { ok: true, droppedColumns, error: null };

    const column = missingColumnFromError(error);
    if (!column || required.has(column) || !(column in payload)) {
      return { ok: false, droppedColumns, error };
    }

    delete payload[column];
    droppedColumns.push(column);
  }

  return {
    ok: false,
    droppedColumns,
    error: { message: `Too many missing columns while writing ${table}` },
  };
}

/** То же для update(...).eq(...): используется для `capi_tokens`. */
export async function updateResilient(
  svc: ResilientClient,
  table: string,
  values: Record<string, unknown>,
  match: { column: string; value: string },
): Promise<WriteOutcome> {
  const payload: Record<string, unknown> = { ...values };
  const droppedColumns: string[] = [];

  for (let attempt = 0; attempt <= MAX_COLUMN_RETRIES; attempt += 1) {
    if (Object.keys(payload).length === 0) {
      return { ok: true, droppedColumns, error: null };
    }

    const { error } = await svc.from(table).update(payload).eq(match.column, match.value);
    if (!error) return { ok: true, droppedColumns, error: null };

    const column = missingColumnFromError(error);
    if (!column || !(column in payload)) {
      return { ok: false, droppedColumns, error };
    }

    delete payload[column];
    droppedColumns.push(column);
  }

  return {
    ok: false,
    droppedColumns,
    error: { message: `Too many missing columns while updating ${table}` },
  };
}

/** Предупреждение для ответа API и логов. */
export function schemaWarning(table: string, droppedColumns: string[]): string | null {
  if (droppedColumns.length === 0) return null;
  return `В таблице ${table} нет колонок: ${droppedColumns.join(', ')} — примените миграции supabase/migrations, иначе часть данных CAPI не сохраняется`;
}
