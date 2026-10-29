import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabaseAdmin';
import { authFromRequest } from '@/lib/requestUser';
import { decideAccess, type AccessDecision, type ProfileErrorLike } from '@/lib/adminAccess';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * «Кто я и есть ли у меня права» — ответ сервера, а не браузера.
 *
 * Зачем отдельный маршрут. Админка определяет роль запросом из браузера к
 * PostgREST под сессией пользователя. Если браузерный путь сломан (устаревший
 * кэш схемы, снятый грант, истёкшая сессия, потерянная сеть Supabase), страница
 * молча показывала «Доступ запрещён» — хотя в базе роль на месте. Здесь роль
 * читается сервисным ключом: RLS его не фильтрует, поэтому ответ говорит правду
 * о данных, а поле `source` — о том, каким путём она получена.
 *
 * Маршрут отдаёт только собственные данные вызывающего: id, роль, позывной.
 * Ничего чужого и никаких ключей.
 */
export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'no-store, max-age=0' };

  let userId: string | null = null;
  let email: string | null = null;
  let sessionProfile: { role?: string | null; cmdr_name?: string | null } | null = null;
  let sessionError: ProfileErrorLike | null = null;

  try {
    const { user, supabase } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json(
        { ...decideAccess({ userId: null }), userId: null, email: null, profile: null, source: 'session' },
        { headers },
      );
    }
    userId = user.id;
    email = user.email ?? null;

    // Сначала сервисный клиент: он отвечает на вопрос «что в базе на самом деле».
    try {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('profiles')
        .select('role, cmdr_name')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        sessionError = { message: error.message, code: error.code, details: error.details, hint: error.hint };
      } else {
        sessionProfile = (data as typeof sessionProfile) ?? null;
      }
      const decision = decideAccess({ userId, profile: sessionProfile, error: sessionError });
      return NextResponse.json(
        { ...decision, userId, email, profile: sessionProfile, source: sessionError ? 'session' : 'service' },
        { headers },
      );
    } catch (error) {
      // Сервисного ключа нет (или клиент не собрался) — спрашиваем базу сессией.
      const { data, error: rlsError } = await supabase
        .from('profiles')
        .select('role, cmdr_name')
        .eq('id', userId)
        .maybeSingle();
      const failure: ProfileErrorLike | null = rlsError
        ? { message: rlsError.message, code: rlsError.code, details: rlsError.details, hint: rlsError.hint }
        : { message: error instanceof Error ? error.message : String(error) };
      const decision: AccessDecision = decideAccess({
        userId,
        profile: (data as typeof sessionProfile) ?? null,
        error: rlsError ? failure : null,
      });
      return NextResponse.json(
        { ...decision, userId, email, profile: data ?? null, source: 'session' },
        { headers },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ...decideAccess({ userId, profile: null, error: { message } }),
        userId,
        email,
        profile: null,
        source: 'session',
      },
      { status: 200, headers },
    );
  }
}
