import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { resetJournalData, type JournalResetOutcome } from '@/lib/journalReset';

export const dynamic = 'force-dynamic';
// Удаление данных по нескольким таблицам может занять дюжину секунд
// на аккаунте с большой историей поставок. Даём запас по времени.
export const maxDuration = 60;

interface ResetBody {
  /** API token (для Colonial Helper). */
  token?: string;
  /**
   * Секции, которые нужно сбросить. По умолчанию — все (true). Сайт
   * отправляет полный набор; программа может очистить только часть, если
   * часть данных пользователь уже успел перезагрузить вручную.
   */
  sections?: {
    deliveries?: boolean;
    imports?: boolean;
    legacyEvents?: boolean;
    pilotStats?: boolean;
    systemScans?: boolean;
    detachSites?: boolean;
  };
  /**
   * Флаг-подтверждение: клиент обязан явно передать `confirm: true`. Без
   * него маршрут не будет ничего удалять — это защищает от GET-ссылки
   * или случайного пустого POST из старой версии Helper'а.
   */
  confirm?: boolean;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = getServerSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Server credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Поддерживаем два способа авторизации: сессия сайта и API-токен Helper'а. */
async function resolveUserId(req: Request, body: ResetBody): Promise<string | null> {
  // 1. Сессия сайта (cookie/bearer) — главный путь для страницы «Журнал CMDR».
  // `authFromRequest` смотрит и cookie, и Authorization: Bearer <session-jwt>.
  try {
    const svc = createServiceClient();
    const { user } = await authFromRequest(req);
    if (user) return user.id;
    // Если заголовок Authorization был, но сессия не прошла — не падаем в
    // API-token валидацию: клиент явно пытался залогиниться как пользователь.
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) return null;
  } catch {
    // Любой сбой сессии — пробуем токен.
  }

  // 2. API-токен Colonial Helper'а.
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return null;
  const svc = getAdminClient();
  const tokenHash = hashToken(token);
  const { data: apiToken, error } = await svc
    .from('api_tokens')
    .select('user_id, is_revoked')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error || !apiToken || apiToken.is_revoked) return null;
  // Обновляем last_used_at фоново — не ошибка, если не получилось.
  void svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
  return apiToken.user_id;
}

export async function POST(req: Request) {
  try {
    let body: ResetBody = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as ResetBody;
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (body.confirm !== true) {
      return NextResponse.json(
        { error: 'Требуется подтверждение: передайте confirm: true' },
        { status: 400 },
      );
    }

    const userId = await resolveUserId(req, body);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const svc = getAdminClient();
    const sections = body.sections && typeof body.sections === 'object' ? body.sections : {};
    const outcome: JournalResetOutcome = await resetJournalData(svc, userId, {
      deliveries: sections.deliveries !== false,
      imports: sections.imports !== false,
      legacyEvents: sections.legacyEvents !== false,
      pilotStats: sections.pilotStats !== false,
      systemScans: sections.systemScans !== false,
      detachSites: sections.detachSites !== false,
    });

    return NextResponse.json({
      ok: true,
      reset: outcome,
      message: 'Журнальные данные сброшены. Теперь можно загрузить логи заново.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reset journal data';
    console.error('[journal reset] Failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
