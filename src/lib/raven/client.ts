/**
 * Запись в Raven Colonial от имени пользователя (серверная сторона).
 *
 * Использует тот же контракт, что Colonial Helper (`uploader/raven_colonial_api.py`):
 * заголовок `rcc-key`, `PUT /api/project/` с обязательными `marketId`,
 * `systemAddress`, `buildName`, привязка к командиру `PUT /project/{id}/link/{cmdr}`.
 */
import { ravenBase } from '@/lib/ravenColonial';

export interface RavenWriteResult {
  ok: boolean;
  status: number;
  data: unknown;
  error: string | null;
}

function api(path: string): string {
  return `${ravenBase()}/api${path}`;
}

async function call(method: string, path: string, key: string, body?: unknown): Promise<RavenWriteResult> {
  try {
    const res = await fetch(api(path), {
      method,
      headers: {
        'rcc-key': key,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }
    if (res.ok) return { ok: true, status: res.status, data, error: null };
    const detail = typeof data === 'string' ? data : '';
    return {
      ok: false,
      status: res.status,
      data,
      error: res.status === 401
        ? 'ключ RCC не принят (401) — проверьте ключ на сайте Raven Colonial'
        : `Raven Colonial ответил ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: `Raven Colonial не ответил (${(err as Error).message})` };
  }
}

/** Проверка ключа и имя командира, которое знает Raven. */
export async function ravenWhoAmI(key: string): Promise<RavenWriteResult & { displayName: string }> {
  const res = await call('GET', '/cmdr/', key);
  let displayName = '';
  const data = res.data as Record<string, unknown> | null;
  if (data && typeof data === 'object') {
    for (const field of ['displayName', 'DisplayName', 'name', 'cmdrName']) {
      const value = data[field];
      if (typeof value === 'string' && value.trim()) {
        displayName = value.trim();
        break;
      }
    }
  }
  return { ...res, displayName };
}

export function ravenCreateProject(key: string, draft: Record<string, unknown>): Promise<RavenWriteResult> {
  return call('PUT', '/project/', key, draft);
}

export function ravenLinkCommander(key: string, buildId: string, cmdr: string): Promise<RavenWriteResult> {
  return call('PUT', `/project/${encodeURIComponent(buildId)}/link/${encodeURIComponent(cmdr)}`, key);
}

/** buildId из ответа создания (объект или строка). */
export function buildIdFromResponse(data: unknown): string {
  if (data && typeof data === 'object' && 'buildId' in data) {
    return String((data as { buildId: unknown }).buildId ?? '').trim();
  }
  if (typeof data === 'string') return data.trim().replace(/^"|"$/g, '');
  return '';
}
