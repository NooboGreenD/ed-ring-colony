import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';

export const dynamic = 'force-dynamic';

/**
 * Фоновая синхронизация привязанных аккаунтов Frontier.
 *
 * Работа делегирована `syncCapiPilot()` — тому же коду, что выполняют
 * колбэк OAuth и кнопка «Синхронизировать». Прежняя версия дублировала
 * логику и расходилась с ней: обновляла токен только перед первым запросом,
 * читала несуществующие поля профиля (`profile.credits`, `profile.ranks`),
 * а на `journal.events` падала целиком, потому что CAPI отдаёт журнал
 * построчным JSON.
 *
 * Пилоты с мёртвым refresh-токеном помечаются `is_active = false`, чтобы
 * cron не бился в них каждый час: у Frontier refresh живёт не дольше 25
 * дней, после чего нужна повторная авторизация.
 */
async function handle() {
  const svc = createServiceClient();
  const { data: tokens, error: tokenError } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('is_active', true)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(10);

  if (tokenError) throw new Error(tokenError.message);

  if (!tokens || tokens.length === 0) {
    return NextResponse.json({ synced: 0, failed: 0, total: 0, ok: true });
  }

  let synced = 0;
  let needsReauth = 0;
  let eventsImported = 0;

  for (const token of tokens) {
    const result = await syncCapiPilot(svc, token.user_id, token);
    for (const warning of result.warnings) {
      console.warn(`[Cron CAPI] User ${token.user_id}:`, warning);
    }

    if (result.ok) {
      synced += 1;
      eventsImported += result.eventsImported;
      continue;
    }

    console.error(`[Cron CAPI] User ${token.user_id}:`, result.error);
    if (result.needsReauth) {
      needsReauth += 1;
      await markCapiTokenBroken(svc, token.user_id, result.error || 'Frontier отклонил токен');
    }
  }

  const failed = tokens.length - synced;
  return NextResponse.json(
    { ok: failed === 0, synced, failed, needsReauth, eventsImported, total: tokens.length },
    { status: failed === 0 ? 200 : 502 },
  );
}

export async function GET(req: Request) {
  return runCronTask(req, 'capi-sync', handle);
}

export const POST = GET;
