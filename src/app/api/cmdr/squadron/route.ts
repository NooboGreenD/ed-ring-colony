import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import {
  SquadronApplyError,
  applyPilotSquadron,
  parseSquadronReport,
  pilotGameSquadronFromProfile,
} from '@/lib/squadronGame';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Эскадрилья пилота из журнала игры.
 *
 *   POST { game_squadron_id, game_squadron_name?, game_squadron_rank?, event_at? }
 *        — Helper (API-токен) или сайт (сессия). Сайт сам раскладывает
 *          сведения: профиль, связь эскадрильи с игровой, состав и ранг;
 *   GET  — что сейчас известно об эскадрилье пилота (для страницы профиля и
 *          для самопроверки Helper'а).
 *
 * Права: только своя строка. Токен Helper'а или сессия определяют пилота —
 * подставить чужой `user_id` нельзя, его здесь просто нет.
 */
export async function POST(req: Request) {
  const t = await apiTranslate();
  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ ok: false, error: t('sqg.invalidJson') }, { status: 400 });
  }

  const viewer = await resolveRequestUser(req, body.token);
  if (!viewer) {
    return NextResponse.json({ ok: false, error: t('sqg.unauthorized') }, { status: 401 });
  }

  const report = parseSquadronReport(body);
  if (!report) {
    // Пилот без эскадрильи: `SquadronID` в журнале нет. Это не ошибка —
    // сообщать нечего, и трогать сохранённые сведения нельзя.
    return NextResponse.json({ ok: true, stored: false, reason: 'no_squadron' });
  }

  const svc = createServiceClient();
  try {
    const result = await applyPilotSquadron(svc, viewer.userId, report, {
      source: viewer.via === 'api_token' ? 'helper' : 'web',
      // Автовступление в состав: пилот уже в эскадрилье в игре, и сайт
      // повторяет то же состояние. Права при этом не выдаются — см. миграцию.
      join: body.join !== false,
    });
    return NextResponse.json({ ...result, ok: true, stored: true });
  } catch (error) {
    if (error instanceof SquadronApplyError) {
      // Отставшая база (миграция ещё не накатана) — честный 503 с подсказкой,
      // а не 500: Helper повторит отправку после обновления проекта.
      if (error.schemaOutdated) {
        console.warn('[cmdr/squadron] schema outdated:', error.message);
        return NextResponse.json(
          { ok: false, error: t('sqg.schemaOutdated'), schemaOutdated: true },
          { status: 503 },
        );
      }
      console.error('[cmdr/squadron] apply failed:', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[cmdr/squadron] POST failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const t = await apiTranslate();
  const viewer = await resolveRequestUser(req);
  if (!viewer) {
    return NextResponse.json({ ok: false, error: t('sqg.unauthorized') }, { status: 401 });
  }

  const svc = createServiceClient();
  try {
    const { data, error } = await svc
      .from('profiles')
      .select('game_squadron_id, game_squadron_name, game_squadron_rank, game_squadron_rank_name, game_squadron_at, game_squadron_site_id, game_squadron_source')
      .eq('id', viewer.userId)
      .maybeSingle();
    // Старая база без новых колонок: отвечаем «неизвестно», а не 500 — иначе
    // страница профиля ломалась бы целиком до применения миграции.
    if (error) {
      const missing = /column .* does not exist|could not find the .* column/i.test(error.message ?? '');
      if (missing) return NextResponse.json({ ok: true, squadron: null, schemaOutdated: true });
      throw new Error(error.message);
    }
    const squadron = pilotGameSquadronFromProfile(data);
    if (squadron.siteSquadronId) {
      const { data: site } = await svc
        .from('squadrons')
        .select('id, name, tag')
        .eq('id', squadron.siteSquadronId)
        .maybeSingle();
      if (site) squadron.siteSquadronName = typeof site.name === 'string' ? site.name : null;
    }
    return NextResponse.json({ ok: true, squadron });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[cmdr/squadron] GET failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
