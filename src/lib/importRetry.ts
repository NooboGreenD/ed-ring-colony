/**
 * Отправка журнала пачками с повтором для строк, которые база не приняла.
 *
 * Вынесено из `src/app/account/page.tsx` намеренно: это ядро исправления бага
 * «загрузка обрывается на 30-м пакете из 500+», а внутри компонента оно
 * непроверяемо — там сотни строк состояния и DOM.
 *
 * Сервер больше не отвечает 500 на `statement_timeout`, а возвращает
 * `deferred` — число строк, которые не удалось записать. Поэтому основной
 * проход доходит до конца, а отложенные пачки повторяются отдельно. Повтор
 * идемпотентен: у каждой доставки стабильный `source_hash`.
 */

export interface ChunkResponse {
  inserted?: number;
  duplicates?: number;
  eventsFound?: number;
  /** Сколько строк база не приняла из-за `statement_timeout`. */
  deferred?: number;
}

export interface ChunkedUploadOutcome {
  inserted: number;
  duplicates: number;
  eventsFound: number;
  /** Строки, которые так и не удалось записать. */
  deferred: number;
  /** Сколько пачек пришлось повторять. */
  retriedChunks: number;
}

export interface ChunkedUploadOptions<T> {
  /** Отправить одну пачку. Может бросить — пачка уйдёт в повтор. */
  send: (chunk: T[]) => Promise<ChunkResponse>;
  /** Сколько дополнительных проходов по отложенным пачкам. По умолчанию 2. */
  retryPasses?: number;
  /**
   * Пауза перед повторным проходом, мс. По умолчанию 1500.
   *
   * Без паузы повтор бесполезен: база только что не успела по
   * `statement_timeout`, и мгновенный повтор с высокой вероятностью не успеет
   * снова. Пауза даёт нагрузке спасть.
   */
  retryDelayMs?: number;
  /** Сообщить о начале повторного прохода (для индикатора прогресса). */
  onRetryPass?: (pass: number, remainingChunks: number) => void;
  /** Прогресс основного прохода: номер пачки и их общее число. */
  onProgress?: (index: number, total: number) => void;
  /** Точка отмены — например, `setTimeout` в тестах. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_PASSES = 2;
const DEFAULT_RETRY_DELAY_MS = 1500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Отправить пачки и повторить те, что база не приняла.
 *
 * Не бросает при сбое отдельной пачки: потерянная пачка попадает в повтор, а
 * после исчерпания проходов — в `deferred`. Прерывать загрузку из-за одной
 * пачки и терять остальные как раз и было исходным багом.
 */
export async function sendInChunks<T>(
  chunks: T[][],
  options: ChunkedUploadOptions<T>,
): Promise<ChunkedUploadOutcome> {
  const {
    send,
    retryPasses = DEFAULT_RETRY_PASSES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    onRetryPass,
    onProgress,
    sleep = defaultSleep,
  } = options;

  const outcome: ChunkedUploadOutcome = {
    inserted: 0,
    duplicates: 0,
    eventsFound: 0,
    deferred: 0,
    retriedChunks: 0,
  };

  const pending: T[][] = [];
  const total = chunks.length;

  const account = (response: ChunkResponse, chunk: T[], deferredSink: T[][]) => {
    outcome.inserted += response.inserted ?? 0;
    outcome.duplicates += response.duplicates ?? 0;
    outcome.eventsFound += response.eventsFound ?? 0;
    if ((response.deferred ?? 0) > 0) deferredSink.push(chunk);
  };

  for (let index = 0; index < total; index += 1) {
    onProgress?.(index + 1, total);
    const chunk = chunks[index];
    try {
      account(await send(chunk), chunk, pending);
    } catch {
      // Сеть или сервер вовсе: пачка уходит в повтор, а не обрывает загрузку.
      pending.push(chunk);
    }
  }

  for (let pass = 1; pass <= retryPasses && pending.length > 0; pass += 1) {
    outcome.retriedChunks += pending.length;
    onRetryPass?.(pass, pending.length);
    if (retryDelayMs > 0) await sleep(retryDelayMs);

    const retry = pending.splice(0, pending.length);
    for (const chunk of retry) {
      try {
        account(await send(chunk), chunk, pending);
      } catch {
        pending.push(chunk);
      }
    }
  }

  outcome.deferred = pending.reduce((sum, chunk) => sum + chunk.length, 0);
  return outcome;
}
