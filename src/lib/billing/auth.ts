import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/requestUser';
import { nickFromUser } from '@/lib/authProfile';

export const BILLING_VIEW_ROLES = ['admin', 'moderator', 'support_manager'];
export const BILLING_MANAGE_ROLES = ['admin'];

export interface BillingActor {
  userId: string;
  cmdrName: string;
  email: string | null;
  role: string;
  isPreview: boolean;
}

/**
 * Dev/preview fallback: when there is no Supabase session AND we are not in
 * production, act as a preview admin so the UI can be inspected locally.
 * Never enabled in production.
 */
function previewAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.BILLING_PREVIEW_ADMIN === '1';
}

export async function billingActor(req: Request): Promise<BillingActor | null> {
  const { user, supabase } = await authFromRequest(req);
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('cmdr_name, role, email').eq('id', user.id).maybeSingle();
    return {
      userId: user.id,
      cmdrName: profile?.cmdr_name || nickFromUser(user, profile as any),
      email: user.email || profile?.email || null,
      role: profile?.role || 'user',
      isPreview: false,
    };
  }
  if (previewAllowed()) {
    return { userId: 'preview-user-guest', cmdrName: 'CMDR Preview', email: null, role: 'admin', isPreview: true };
  }
  return null;
}

export function forbidden(msg = 'Требуется авторизация') {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export async function requireUser(req: Request): Promise<{ actor: BillingActor } | { response: NextResponse }> {
  const actor = await billingActor(req);
  if (!actor) return { response: forbidden() };
  return { actor };
}

export async function requireStaff(req: Request, roles = BILLING_VIEW_ROLES): Promise<{ actor: BillingActor } | { response: NextResponse }> {
  const actor = await billingActor(req);
  if (!actor) return { response: forbidden() };
  if (!roles.includes(actor.role)) return { response: NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 }) };
  return { actor };
}

export const requireAdmin = (req: Request) => requireStaff(req, BILLING_MANAGE_ROLES);

export function errorResponse(err: any, status = 500) {
  const msg = err?.message || 'Internal Server Error';
  console.error('[billing api]', msg);
  return NextResponse.json({ error: msg }, { status });
}
