import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authFromRequest } from '@/lib/supabaseServer';
import { maskPilotStats, privacyForViewer } from '@/lib/privacy';
import { createHash } from 'crypto';
import { assessProfileBinding } from '@/lib/capi/profileBinding';
import { isPlausibleMercenaryCoins } from '@/lib/journalTelemetry';
import { mergePilotStats } from '@/lib/pilotDossier';
import { upsertResilient, updateResilient, schemaWarning } from '@/lib/capi/persist';

export const dynamic = 'force-dynamic';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cmdr = (searchParams.get('cmdr') || searchParams.get('name') || '').trim();

    if (!cmdr) {
      return NextResponse.json({ error: 'cmdr parameter is required' }, { status: 400 });
    }

    // 1. Поиск в pilot_stats
    const { data: pilotStats } = await supabaseAdmin
      .from('pilot_stats')
      .select('*')
      .ilike('cmdr_name', cmdr)
      .maybeSingle();

    // 2. Поиск в capi_profiles
    const { data: capiProfile } = await supabaseAdmin
      .from('capi_profiles')
      .select('*')
      .ilike('cmdr_name', cmdr)
      .maybeSingle();

    // 3. Агрегация открытий из system_scans
    const { count: firstDiscoveriesCount } = await supabaseAdmin
      .from('system_scans')
      .select('id', { count: 'exact', head: true })
      .ilike('first_discovered_by', cmdr);

    const { count: firstMappedCount } = await supabaseAdmin
      .from('system_scans')
      .select('id', { count: 'exact', head: true })
      .ilike('first_mapped_by', cmdr);

    // Одно слияние на двоих с страницей досье: `/cmdr/[name]` и этот
    // эндпоинт обязаны показывать одинаковые числа из одних и тех же таблиц.
    const merged = mergePilotStats({
      pilotStats,
      capiProfile,
      cmdrName: cmdr,
      firstDiscoveredCount: firstDiscoveriesCount,
      firstMappedCount: firstMappedCount,
    });

    // Конфиденциальность: этот эндпоинт публичный, а данные в нём личные.
    // Без фильтрации любой мог снять баланс, ранги и текущее положение
    // командира, который их скрыл в настройках.
    const ownerId = pilotStats?.user_id || capiProfile?.user_id || null;
    let viewerId: string | null = null;
    try {
      const { user } = await authFromRequest(req);
      viewerId = user?.id ?? null;
    } catch {
      viewerId = null;
    }

    const { data: ownerProfile } = ownerId
      ? await supabaseAdmin.from('profiles').select('privacy_settings, cmdr_name').eq('id', ownerId).maybeSingle()
      : { data: null };

    const privacy = privacyForViewer(ownerProfile?.privacy_settings, viewerId, ownerId);
    const visible = maskPilotStats(merged, privacy);
    const binding = assessProfileBinding(ownerProfile?.cmdr_name, capiProfile?.cmdr_name);

    // Скрытые поля отдаём как null, а не как 0: «0 кредитов» — это ложь,
    // а null клиент показывает как «—». Binding помогает клиенту отличить
    // валидную CAPI-привязку от одноимённого, но конфликтующего кэша.
    return NextResponse.json({
      ok: true,
      stats: visible,
      privacy,
      binding: {
        status: binding.status,
        displayName: binding.displayName,
        nameMismatch: binding.nameMismatch,
      },
    });
  } catch (err: any) {
    console.error('[cmdr/stats] GET error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    let userId: string | null = null;
    let cmdrName = (body.cmdr || body.cmdr_name || '').trim();
    // Источник данных: API-токен — программа (Colonial Helper), сессия —
    // сайт. От источника зависит приоритет записи (см. ниже).
    let source: 'helper' | 'web' = 'web';

    // Аутентификация: через токен helper'а или веб-сессию
    if (body.token) {
      const tokenHash = hashToken(String(body.token).trim());
      const { data: apiToken } = await supabaseAdmin
        .from('api_tokens')
        .select('user_id, is_revoked')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (apiToken && !apiToken.is_revoked) {
        userId = apiToken.user_id;
        source = 'helper';
      }
    }

    if (!userId) {
      const { user } = await authFromRequest(req);
      if (user) userId = user.id;
    }

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized: valid API token or session required' }, { status: 401 });
    }

    // UUID пользователя — главный ключ, а имя нужно только для ссылки на
    // досье. Заполняем пустой профиль именем из Uploader/CAPI и никогда не
    // перезаписываем уже сохранённый ник автоматически.
    const { data: siteProfile } = await supabaseAdmin
      .from('profiles')
      .select('cmdr_name')
      .eq('id', userId)
      .maybeSingle();
    const binding = assessProfileBinding(siteProfile?.cmdr_name, cmdrName);
    if (binding.status === 'linked' && binding.displayName) {
      await supabaseAdmin.from('profiles').update({ cmdr_name: binding.displayName }).eq('id', userId);
    }
    cmdrName = binding.displayName || cmdrName;

    const statsPayload: Record<string, any> = {
      user_id: userId,
      cmdr_name: cmdrName || null,
      last_updated: new Date().toISOString(),
    };

    if (body.credits != null) statsPayload.credits = Number(body.credits) || 0;
    if (body.arx != null) statsPayload.arx = Number(body.arx) || 0;
    // Жетоны Operations ограничены игрой (9999). Старые сборки Helper'а
    // присылали сюда Combat_Bond_Profits — кредиты за боевые облигации, — и
    // досье показывало сотни миллионов «монет наёмников». Мусор не пишем.
    if (body.mercenary_coins != null && isPlausibleMercenaryCoins(body.mercenary_coins)) {
      statsPayload.mercenary_coins = Number(body.mercenary_coins) || 0;
    }
    if (body.mercenary_rank != null) statsPayload.mercenary_rank = Number(body.mercenary_rank) || 0;
    if (body.exobiologist_rank != null) statsPayload.exobiologist_rank = Number(body.exobiologist_rank) || 0;
    // Боевые/торговые/исследовательские ранги и фракции: приходят из CAPI
    // (авторизация PKCE в Colonial Helper), поэтому раньше в pilot_stats не
    // попадали вовсе, хотя досье их показывает.
    if (body.combat_rank != null) statsPayload.combat_rank = Number(body.combat_rank) || 0;
    if (body.trade_rank != null) statsPayload.trade_rank = Number(body.trade_rank) || 0;
    if (body.explore_rank != null) statsPayload.explore_rank = Number(body.explore_rank) || 0;
    if (body.empire_rank != null) statsPayload.empire_rank = Number(body.empire_rank) || 0;
    if (body.federation_rank != null) statsPayload.federation_rank = Number(body.federation_rank) || 0;
    if (typeof body.current_ship === 'string') statsPayload.current_ship = body.current_ship.slice(0, 200);
    if (typeof body.current_system === 'string') statsPayload.current_system = body.current_system.slice(0, 200);
    if (typeof body.current_station === 'string') statsPayload.current_station = body.current_station.slice(0, 200);
    if (body.first_discoveries_count != null) statsPayload.first_discoveries_count = Number(body.first_discoveries_count) || 0;
    if (body.first_mapped_count != null) statsPayload.first_mapped_count = Number(body.first_mapped_count) || 0;
    if (body.first_footfalls_count != null) statsPayload.first_footfalls_count = Number(body.first_footfalls_count) || 0;
    if (body.bio_samples_count != null) statsPayload.bio_samples_count = Number(body.bio_samples_count) || 0;
    if (body.bio_species_count != null) statsPayload.bio_species_count = Number(body.bio_species_count) || 0;
    if (body.bio_value_cr != null) statsPayload.bio_value_cr = Number(body.bio_value_cr) || 0;
    if (body.exploration_stats != null && typeof body.exploration_stats === 'object') {
      statsPayload.exploration_stats = body.exploration_stats;
    }
    // Источник последней записи — чтобы данные программы не перетирали
    // данные, загруженные через сайт (см. ниже).
    statsPayload.stats_source = source;
    statsPayload.stats_source_at = new Date().toISOString();

    // Защита источника: если строку статистики последней записала загрузка
    // журналов НА САЙТЕ, программа (Colonial Helper) её не перетирает.
    // Раньше побеждал последний записавший, и досье «прыгало» между двумя
    // парсерами в зависимости от того, что успело отработать.
    let statsSkipped: string | null = null;
    if (source === 'helper') {
      const { data: existingStats } = await supabaseAdmin
        .from('pilot_stats')
        .select('stats_source')
        .eq('user_id', userId)
        .maybeSingle();
      if (existingStats?.stats_source === 'web') {
        statsSkipped = 'web_source';
      }
    }

    if (!statsSkipped) {
      // 1. Запись в pilot_stats. Upsert устойчив к отставшей схеме: на базе
      // без миграции 20261010000000 колонки stats_source* отбрасываются с
      // предупреждением, а не роняют всю запись.
      const statsWrite = await upsertResilient(supabaseAdmin, 'pilot_stats', statsPayload, {
        onConflict: 'user_id',
      });
      const statsSchemaWarning = schemaWarning('pilot_stats', statsWrite.droppedColumns);
      if (statsSchemaWarning) console.warn('[cmdr/stats]', statsSchemaWarning);
      if (!statsWrite.ok) {
        // Раньше ошибка upsert молча игнорировалась и отвечали ok:true —
        // программа не знала, что сводка не дошла. Честно говорим о сбое.
        console.error('[cmdr/stats] pilot_stats write:', statsWrite.error?.message);
        return NextResponse.json({
          error: `pilot_stats write failed: ${statsWrite.error?.message ?? 'unknown error'}`,
          binding: {
            status: binding.status,
            displayName: binding.displayName,
            nameMismatch: binding.nameMismatch,
          },
        }, { status: 502 });
      }

      // 2. Также обновляем capi_profiles, если запись есть. Имя CAPI не
      // перезаписываем значением из site profile: иначе конфликт имён исчезал бы
      // только потому, что Uploader прислал очередную статистику. Поля
      // источника (stats_source*) в capi_profiles не нужны — они отбрасываются.
      const {
        user_id: _statsUserId,
        cmdr_name: _statsCmdrName,
        stats_source: _statsSource,
        stats_source_at: _statsSourceAt,
        ...capiStatsPayload
      } = statsPayload;
      const capiWrite = await updateResilient(supabaseAdmin, 'capi_profiles', capiStatsPayload, {
        column: 'user_id',
        value: userId,
      });
      if (!capiWrite.ok) {
        console.warn('[cmdr/stats] capi_profiles update:', capiWrite.error?.message);
      }
    }

    return NextResponse.json({
      ok: true,
      stats: statsSkipped ? null : statsPayload,
      // machine-readable причина, если запись защищена источником
      pilotStatsSkipped: statsSkipped,
      ...(statsSkipped
        ? { warning: 'Статистика пилота не записана: приоритет у данных, загруженных через сайт. Повторная загрузка журналов на сайте снимает защиту.' }
        : {}),
      binding: {
        status: binding.status,
        displayName: binding.displayName,
        nameMismatch: binding.nameMismatch,
      },
    });
  } catch (err: any) {
    console.error('[cmdr/stats] POST error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
