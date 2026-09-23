import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { applyEnvKeys } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Recreate services so edited env keys take effect. Goes through the same
 * process slot as the project update (the agent answers `kind: 'env'`), so a
 * key change can never overlap a rebuild. NEXT_PUBLIC_* keys are baked into
 * the bundle at build time — they need the full «Обновить сейчас».
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = await request.json().catch(() => null) as { scope?: unknown } | null;
    const scope = body?.scope === 'all' ? 'all' : 'web';

    const result = await applyEnvKeys(scope);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, update: result.update },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({ success: true, update: result.update }, { status: 202, ...NO_STORE });
  } catch {
    return NextResponse.json(
      { error: 'Не удалось применить изменения окружения' },
      { status: 500, ...NO_STORE },
    );
  }
}
