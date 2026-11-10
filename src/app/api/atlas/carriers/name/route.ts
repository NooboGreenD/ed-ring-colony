import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { normalizeCarrierName, isCarrierMarketId } from '@/lib/carrierRegistry';
import { setCarrierName } from '@/lib/carrierRegistryStore';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/atlas/carriers/name
 *
 * Уточнить имя авианосца. Это единственный способ, которым в реестр попадает
 * имя: EDDN его не присылает, сторонние базы — не источник (решение 10.11.2026).
 *
 * Кто может: владелец носителя (его журнал, `fleet_carriers.owner_id`) или
 * пилот, который на нём побывал (`carrier_visits`). Проверку делает
 * SQL-функция `carrier_directory_set_name`, а не этот маршрут: право не
 * должно зависеть от того, кто и как вызвал API.
 *
 * Тело: `{ carrierId, name }`. Позывной именем не считается — он и так есть
 * отдельной колонкой. Пустое имя не стирает сохранённое, а отклоняется:
 * «уточнил» и «забыл» — разные действия.
 */
export async function PUT(request: Request) {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: t('api.invalidJson') }, { status: 400 });
  }

  const carrierId = String(body.carrierId ?? '').trim();
  if (!isCarrierMarketId(carrierId)) {
    return NextResponse.json({ error: t('api.invalidRequest') }, { status: 400 });
  }
  const normalized = normalizeCarrierName(body.name);
  if (!normalized.ok) {
    const message = normalized.error === 'too_long'
      ? t('acw.nameTooLong')
      : normalized.error === 'callsign'
        ? t('acw.nameIsCallsign')
        : t('api.invalidRequest');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const svc = createServiceClient();
    const result = await setCarrierName(svc, user.id, carrierId, normalized.name);
    if (!result.ok) {
      const forbidden = result.error === 'forbidden' || result.error === 'unauthorized';
      return NextResponse.json(
        { error: forbidden ? t('acw.nameForbidden') : t('acw.nameFailed') },
        { status: forbidden ? 403 : 503 },
      );
    }
    return NextResponse.json(
      { ok: true, carrierId, name: normalized.name },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[atlas/carriers/name]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('acw.nameFailed') }, { status: 503 });
  }
}
