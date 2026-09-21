import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/** Only a shared header secret authorizes maintenance, never a User-Agent or URL. */
export function isCronAuthorized(request: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret?.trim()) return false;
  const authorization = request.headers.get('authorization');
  const supplied = authorization
    ? (/^Bearer (.+)$/i.exec(authorization)?.[1] ?? '')
    : (request.headers.get('x-cron-secret') ?? '');
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// One Next.js server process in the self-hosted deployment. A timed-out HTTP
// caller must not start a second copy while the first handler is still running.
// Multiple web replicas would require a shared DB lease instead.
const state = globalThis as typeof globalThis & { edrcCronLocks?: Set<string> };
const running = state.edrcCronLocks ??= new Set<string>();

export async function runCronTask(request: Request, name: string, task: () => Promise<Response>) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (running.has(name)) {
    return NextResponse.json({ ok: false, error: 'Job already running' }, {
      status: 409, headers: { 'Retry-After': '60' },
    });
  }
  running.add(name);
  try {
    return await task();
  } catch (error) {
    console.error(`[cron/${name}] failed`, error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ ok: false, error: 'Maintenance job failed; check web logs' }, { status: 500 });
  } finally {
    running.delete(name);
  }
}
