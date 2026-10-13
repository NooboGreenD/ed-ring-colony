/** Bounded EDSM calls: a transient failure must not strand an entire scan. */
export async function marketUpstream(
  path: string,
  deadline = Date.now() + 15_000
): Promise<any> {
  const base = (process.env.EDSM_API_BASE || 'https://www.edsm.net').replace(
    /\/$/,
    ''
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(base + path, {
        headers: {
          'User-Agent': 'ED-Ring-Colony/1.0 (https://edringcolony.ru)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(6000, remaining))),
        cache: 'no-store',
      });
      if (response.ok) return await response.json();
      if (response.status === 404) return null;
      if (response.status !== 429 && response.status < 500)
        throw new Error(`EDSM HTTP ${response.status}`);
    } catch {
      /* One retry; callers can fall back to local market reports. */
    }
  }
  throw new Error(
    'EDSM недоступен или не ответил вовремя. Попробуйте позже; проверьте доступ сервера к www.edsm.net.'
  );
}
export function marketError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|failed to fetch|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message)) {
    return 'Не удалось подключиться к источнику рынков. Проверьте подключение сервера к EDSM и базе данных, затем повторите поиск.';
  }
  return message;
}
