import { NextResponse } from 'next/server';
import { authFromRequest, createClient, createServiceClient } from '@/lib/supabaseServer';
import { loadSquadronSummaries } from '@/lib/squadronData';
import { parseSquadronInput, squadronWriteError, tagFromName } from '@/lib/squadronForm';

export const dynamic = 'force-dynamic';

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status')?.trim() || null;
    const limit = boundedInteger(searchParams.get('limit'), 50, 1, 100);
    const offset = boundedInteger(searchParams.get('offset'), 0, 0, 100_000);
    const supabase = await createClient();

    // Build the small public read model from base tables instead of depending
    // on an untracked PostgREST view. A migration recreates the view too, but
    // this endpoint remains available before its schema cache is refreshed.
    const squadrons = await loadSquadronSummaries(supabase, { status, limit, offset });
    return NextResponse.json({ squadrons });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load squadrons';
    console.error('[squadrons GET]', message);
    return NextResponse.json({ error: 'Could not load squadrons' }, { status: 500 });
  }
}

/**
 * Создание эскадрильи.
 *
 * Здесь же лечится жалоба «эскадрильи не создаются». Причин было три:
 *
 *  1. форма страницы `/squadrons` шлёт незаполненные поля пустыми строками,
 *     а проверка требовала у тега 2–10 символов: `tag: ""` — это не
 *     «не указан», поэтому запрос отклонялся ещё до базы;
 *  2. когда тег действительно не приходил, в базу уходил `NULL`, а колонка
 *     `squadrons.tag` объявлена `NOT NULL` — падал уже insert;
 *  3. любой отказ базы превращался в «Could not create squadron», из-за чего
 *     ни пилот, ни поддержка не понимали, что произошло.
 *
 * Теперь ввод нормализуется (`parseSquadronInput`), тег при необходимости
 * собирается из названия, а ошибки записи переводятся в понятный текст.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = parseSquadronInput(body);
  if (!parsed.ok || !parsed.value) {
    return NextResponse.json(
      { error: parsed.errors.join('. '), errors: parsed.errors },
      { status: 400 },
    );
  }

  try {
    const { user } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Войдите в аккаунт' }, { status: 401 });

    // A member relation is authoritative, while created_by covers legacy
    // squadrons made before the automatic membership trigger was available.
    // Use the server-side reader after authenticating so an outdated RLS policy
    // cannot make a commander accidentally create a second squadron.
    const service = createServiceClient();
    const [membershipResponse, createdResponse] = await Promise.all([
      service
        .from('squadron_members')
        .select('squadron_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle(),
      service
        .from('squadrons')
        .select('id')
        .eq('created_by', user.id)
        .limit(1)
        .maybeSingle(),
    ]);
    if (membershipResponse.error) throw membershipResponse.error;
    if (createdResponse.error) throw createdResponse.error;
    if (membershipResponse.data || createdResponse.data) {
      return NextResponse.json({ error: 'Вы уже состоите в эскадрилье. Сначала покиньте текущую.' }, { status: 409 });
    }

    // `squadrons.created_by` ссылается на `profiles`. У аккаунтов, созданных
    // до автоматического создания профиля (или при сбое OAuth), строки может
    // не быть — тогда insert падал внешним ключом. Создаём её молча: это то
    // же, что делает /api/auth/ensure-profile при входе.
    const { data: existingProfile } = await service
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();
    if (!existingProfile) {
      const { error: profileError } = await service
        .from('profiles')
        .insert({ id: user.id, email: user.email ?? null });
      // 23505 — профиль успели создать параллельно; это не ошибка.
      if (profileError && profileError.code !== '23505') {
        console.error('[squadrons POST] profile bootstrap', profileError.message);
        return NextResponse.json({ error: squadronWriteError(profileError) }, { status: 409 });
      }
    }

    const row = { ...parsed.value, created_by: user.id };
    let { data: squadron, error } = await service
      .from('squadrons')
      .insert(row)
      .select()
      .single();

    // Схема отстала и колонки нет — пробуем ещё раз без неё, чтобы эскадрилья
    // всё же появилась (остальные поля пилот дозаполнит в настройках).
    const missing = error?.code === 'PGRST204' || error?.code === '42703'
      ? error.message?.match(/'([^']+)' column/)?.[1] ?? error.message?.match(/column "([^"]+)"/)?.[1]
      : null;
    if (missing && missing in row && !['name', 'created_by'].includes(missing)) {
      const retry = { ...row };
      delete (retry as Record<string, unknown>)[missing];
      console.warn(`[squadrons POST] в таблице squadrons нет колонки ${missing} — примените миграции`);
      ({ data: squadron, error } = await service.from('squadrons').insert(retry).select().single());
    }

    // Колонка tag объявлена NOT NULL на старых базах: подставляем тег из
    // названия, вместо того чтобы возвращать пилоту ошибку PostgreSQL.
    if (error?.code === '23502' && /"?tag"?/.test(error.message ?? '')) {
      ({ data: squadron, error } = await service
        .from('squadrons')
        .insert({ ...row, tag: row.tag || tagFromName(row.name) })
        .select()
        .single());
    }

    if (error || !squadron) {
      console.error('[squadrons POST]', error?.code, error?.message);
      return NextResponse.json({ error: squadronWriteError(error) }, { status: 500 });
    }

    // Состав создаёт триггер on_squadron_created. Если его нет (база не
    // обновлена), эскадрилья осталась бы без командира — дозаписываем сами.
    const { data: membership } = await service
      .from('squadron_members')
      .select('id')
      .eq('squadron_id', squadron.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!membership) {
      const { data: commanderRank } = await service
        .from('squadron_ranks')
        .select('id')
        .eq('squadron_id', squadron.id)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      const { error: memberError } = await service
        .from('squadron_members')
        .insert({
          squadron_id: squadron.id,
          user_id: user.id,
          role: 'commander',
          ...(commanderRank?.id ? { rank_id: commanderRank.id } : {}),
        });
      if (memberError) {
        console.error('[squadrons POST] membership', memberError.message);
        return NextResponse.json(
          { squadron, warning: `Эскадрилья создана, но вас не удалось записать в состав: ${squadronWriteError(memberError)}` },
        );
      }
    }

    return NextResponse.json({ squadron });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create squadron';
    console.error('[squadrons POST]', message);
    return NextResponse.json({ error: squadronWriteError(error as { message?: string }) }, { status: 500 });
  }
}
