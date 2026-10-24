import { lookup as systemLookup } from 'node:dns/promises';
import { CAPI_BASE, CAPI_LEGACY_BASE, capiUserAgent } from './client.ts';

type LookupFn = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
type FetchFn = typeof fetch;

type ProbeOptions = {
  lookup?: LookupFn;
  fetch?: FetchFn;
  dnsTimeoutMs?: number;
  httpsTimeoutMs?: number;
};

export interface CapiHostProbe {
  host: string;
  reachable: boolean;
  dns: { ok: boolean; addressCount?: number; durationMs: number; code?: string; error?: string };
  https: { ok: boolean; status?: number; durationMs: number; code?: string; error?: string };
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function errorInfo(error: unknown): { code?: string; message: string } {
  const root = error instanceof Error ? error : new Error(String(error));
  const cause = root.cause && typeof root.cause === 'object'
    ? root.cause as { code?: unknown; message?: unknown }
    : null;
  const code = typeof cause?.code === 'string'
    ? cause.code
    : typeof (root as Error & { code?: unknown }).code === 'string'
      ? (root as Error & { code: string }).code
      : undefined;
  const message = String(cause?.message || root.message || 'Unknown network error').replace(/\s+/g, ' ').slice(0, 180);
  return { code, message };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${phase} exceeded ${timeoutMs}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeHost(
  base: string,
  lookup: LookupFn,
  fetchImpl: FetchFn,
  dnsTimeoutMs: number,
  httpsTimeoutMs: number,
): Promise<CapiHostProbe> {
  const host = new URL(base).hostname;
  const dnsStarted = performance.now();
  let addressCount = 0;
  try {
    const addresses = await withTimeout(
      lookup(host, { all: true, verbatim: true }),
      dnsTimeoutMs,
      'DNS lookup',
    );
    addressCount = addresses.length;
    if (addressCount === 0) throw new Error('DNS returned no addresses');
  } catch (error) {
    const info = errorInfo(error);
    return {
      host,
      reachable: false,
      dns: { ok: false, durationMs: elapsedSince(dnsStarted), ...info },
      https: { ok: false, durationMs: 0, error: 'Skipped because DNS lookup failed' },
    };
  }

  const dns = { ok: true, addressCount, durationMs: elapsedSince(dnsStarted) };
  const httpsStarted = performance.now();
  try {
    const response = await fetchImpl(`${base}/profile`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(httpsTimeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': capiUserAgent(),
      },
    });
    // No bearer token is sent, so Frontier must not return commander data.
    // Cancel the body as soon as headers arrive; only HTTP/TLS reachability matters.
    try { await response.body?.cancel(); } catch { /* response status already proves the path */ }
    return {
      host,
      reachable: true,
      dns,
      https: { ok: response.status < 500, status: response.status, durationMs: elapsedSince(httpsStarted) },
    };
  } catch (error) {
    return {
      host,
      reachable: false,
      dns,
      https: { ok: false, durationMs: elapsedSince(httpsStarted), ...errorInfo(error) },
    };
  }
}

/**
 * Fast, token-free check of the website server's DNS + HTTPS egress to Frontier.
 * An unauthenticated `/profile` response (usually 401/403) is success here:
 * it proves the server reached the CAPI front door without touching user data.
 */
export async function probeCapiNetwork(options: ProbeOptions = {}): Promise<{
  checkedAt: string;
  timeoutMs: { dns: number; https: number };
  probes: CapiHostProbe[];
}> {
  const lookup = options.lookup ?? systemLookup as LookupFn;
  const fetchImpl = options.fetch ?? fetch;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 3_000;
  const httpsTimeoutMs = options.httpsTimeoutMs ?? 4_000;
  const probes = await Promise.all([
    probeHost(CAPI_BASE, lookup, fetchImpl, dnsTimeoutMs, httpsTimeoutMs),
    probeHost(CAPI_LEGACY_BASE, lookup, fetchImpl, dnsTimeoutMs, httpsTimeoutMs),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    timeoutMs: { dns: dnsTimeoutMs, https: httpsTimeoutMs },
    probes,
  };
}
