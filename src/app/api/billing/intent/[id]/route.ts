import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, errorResponse } from '@/lib/billing/auth';
import { getDriver } from '@/lib/billing/providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Status of the caller's payment intent (used by the return page). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireUser(req);
    if ('response' in auth) return auth.response;
    const { id } = await ctx.params;
    const intent = await billingRepo.getIntent(id);
    if (!intent) return NextResponse.json({ error: 'Платёж не найден' }, { status: 404 });
    const staff = ['admin', 'moderator', 'support_manager'].includes(auth.actor.role);
    if (intent.user_id !== auth.actor.userId && !staff) return NextResponse.json({ error: 'Нет доступа' }, { status: 403 });

    const provider = intent.provider_id ? await billingRepo.getProvider(intent.provider_id) : null;
    const driver = intent.provider_id ? getDriver(intent.provider_id) : null;
    const manualInstructions = intent.provider_id === 'manual' ? provider?.config?.instructions || null : null;

    return NextResponse.json({
      success: true,
      intent: { ...intent, metadata: { description: intent.metadata?.description } },
      provider: provider ? { id: provider.id, name: provider.name, test_mode: provider.test_mode, description: driver?.description } : null,
      manualInstructions,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
