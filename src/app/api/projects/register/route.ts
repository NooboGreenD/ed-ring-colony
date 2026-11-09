import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { normalizeProjectRegistration } from '@/lib/siteProjects';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 512 * 1024;

/**
 * POST /api/projects/register — проект строительства приходит от Helper.
 *
 * Почему сначала сайт
 * -------------------
 * Raven Colonial отвечает 503 и теряет проекты — а вместе с ними Helper
 * переставал видеть действующие стройки в оверлее. Поэтому Helper
 * регистрирует проект здесь, а в Raven дублирует следом, если тот доступен.
 * Отказ Raven не влияет на сохранение: `rc_state` — только диагностика
 * («ok», «unavailable», «no_key»), а не условие записи.
 *
 * Тело: `{ token?, project: {...}, cmdr?: string }`. Поля проекта — те же,
 * что Helper отправляет в `PUT /api/project`: marketId, systemAddress,
 * buildName, buildType, systemName, bodyName, starPos, commodities, maxNeed,
 * colonisationConstructionDepot. Принимается и плоское тело (без `project`):
 * так проще вызывать из отладки.
 *
 * Ответ: `{ ok, project }` — карточка в том виде, в каком её потом
 * отдаёт `/api/projects/active`, чтобы Helper не перечитывал список.
 */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get('content-length')) > MAX_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const user = await resolveRequestUser(request, body.token);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const rawProject = body.project && typeof body.project === 'object' && !Array.isArray(body.project)
      ? (body.project as Record<string, unknown>)
      : body;
    const cmdr = typeof body.cmdr === 'string' && body.cmdr.trim()
      ? body.cmdr.trim()
      : (typeof rawProject.cmdr === 'string' ? rawProject.cmdr : '');

    const normalized = normalizeProjectRegistration({
      ...rawProject,
      // Имя командира приходит отдельным полем запроса: в самом проекте его
      // может не быть, а для списка «мои проекты» оно нужно.
      commander: rawProject.commander ?? cmdr,
      // Состояние Raven присылает Helper после попытки синхронизации.
      rcState: body.rcState ?? rawProject.rcState,
    });
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const svc = createServiceClient();
    const { data, error } = await svc.rpc('construction_project_register', {
      p_project: normalized.value,
      p_user: user.userId,
    });
    if (error) {
      // Старая база без миграции не должна превращать регистрацию проекта в
      // 500 со стеком: говорим прямо, чего не хватает.
      const missing = /construction_projects|function .*construction_project_register|schema cache/i.test(error.message);
      return NextResponse.json({
        error: missing ? 'construction_projects is not migrated yet' : error.message,
        hint: missing ? 'Примените supabase/migrations/20261106090000_construction_projects.sql' : undefined,
      }, { status: missing ? 503 : 500 });
    }

    const saved = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
      ok: true,
      project: saved,
      // Helper использует это, чтобы показать две строки статуса:
      // «сайт: сохранён» и «Raven: 503».
      source: user.via === 'api_token' ? 'helper' : 'web',
      rcState: normalized.value.rc_state,
    });
  } catch (error) {
    console.error('[projects/register] failed:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
