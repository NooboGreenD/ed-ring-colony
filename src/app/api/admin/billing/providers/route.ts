import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';
import { PROVIDER_DRIVERS, getDriver, maskConfig, mergeConfig, webhookUrlFor } from '@/lib/billing/providers';
import type { PaymentProviderView } from '@/types/billing';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function views(): Promise<PaymentProviderView[]> {
  const list = await billingRepo.getProviders();
  return list
    .filter((p) => PROVIDER_DRIVERS[p.id])
    .map((p) => {
      const d = PROVIDER_DRIVERS[p.id];
      return {
        ...p,
        name: p.name || d.name,
        config: maskConfig(d, p.config),
        config_fields: d.fields,
        webhook_url: webhookUrlFor(p.id),
        docs_url: d.docsUrl,
        description: d.description,
        configured: d.isConfigured(p.config),
        methods: d.methods,
      };
    });
}

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    return NextResponse.json({ success: true, providers: await views() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH { id, is_enabled?, test_mode?, config? } */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { id, config, ...rest } = await req.json();
    const driver = getDriver(id);
    const stored = await billingRepo.getProvider(id);
    if (!driver || !stored) return NextResponse.json({ error: 'Провайдер не найден' }, { status: 404 });
    const patch: any = {};
    if (typeof rest.is_enabled === 'boolean') patch.is_enabled = rest.is_enabled;
    if (typeof rest.test_mode === 'boolean') patch.test_mode = rest.test_mode;
    if (typeof rest.display_order === 'number') patch.display_order = rest.display_order;
    if (config && typeof config === 'object') patch.config = mergeConfig(driver, stored.config, config);
    const merged = { ...stored, ...patch };
    if (patch.is_enabled && !driver.isConfigured(merged.config)) {
      return NextResponse.json({ error: 'Нельзя включить провайдера: заполните обязательные поля' }, { status: 400 });
    }
    await billingRepo.updateProvider(id, patch);
    return NextResponse.json({ success: true, providers: await views() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { id, action: 'check' } — test credentials. */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { id, action } = await req.json();
    const driver = getDriver(id);
    const stored = await billingRepo.getProvider(id);
    if (!driver || !stored) return NextResponse.json({ error: 'Провайдер не найден' }, { status: 404 });
    if (action !== 'check') return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
    let result: { ok: boolean; message: string };
    try {
      result = driver.isConfigured(stored.config) ? await driver.check(stored) : { ok: false, message: 'Не заполнены обязательные поля' };
    } catch (e: any) {
      result = { ok: false, message: e?.message || 'Ошибка проверки' };
    }
    await billingRepo.updateProvider(id, { last_check_at: new Date().toISOString(), last_check_ok: result.ok, last_check_msg: result.message });
    return NextResponse.json({ success: true, result, providers: await views() });
  } catch (err) {
    return errorResponse(err);
  }
}
