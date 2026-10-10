import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';
import { loadRavenKey } from '@/lib/raven/keyStore';
import {
  buildIdFromResponse,
  ravenCreateProject,
  ravenLinkCommander,
} from '@/lib/raven/client';
import { buildRavenProjectDraft } from '@/lib/architect/ravenCreate';
import type { ArchitectBody, PlannedSite } from '@/lib/architect/types';

export const dynamic = 'force-dynamic';

/**
 * Создать проект Raven Colonial для постройки плана — с сайта, от имени
 * пользователя (его RCC-ключ лежит на сервере в зашифрованном виде).
 *
 * Клиент получает `buildId` и сам ставит его в запись плана (`ravenBuildId`):
 * дальше эта постройка узнаётся при каждой синхронизации и не дублируется.
 */
export async function POST(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let payload: {
    system?: unknown;
    site?: PlannedSite;
    body?: ArchitectBody | null;
    marketId?: unknown;
    systemAddress?: unknown;
    buildName?: unknown;
    architectName?: unknown;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ожидался JSON' }, { status: 400 });
  }
  if (!payload.site || typeof payload.site !== 'object' || typeof payload.site.id !== 'string') {
    return NextResponse.json({ error: 'Не передана постройка плана' }, { status: 400 });
  }
  const system = typeof payload.system === 'string' ? payload.system.trim() : '';
  if (!system) return NextResponse.json({ error: 'Не указана система' }, { status: 400 });

  const stored = await loadRavenKey(user.id);
  if (stored.error) return NextResponse.json({ error: stored.error }, { status: 500 });
  if (!stored.key) {
    return NextResponse.json({ error: 'Сначала сохраните RCC-ключ Raven Colonial в Архитекторе.' }, { status: 409 });
  }

  const built = buildRavenProjectDraft({
    site: payload.site,
    body: payload.body ?? null,
    systemName: system,
    systemAddress: Number(payload.systemAddress),
    marketId: Number(payload.marketId),
    buildName: typeof payload.buildName === 'string' ? payload.buildName : '',
    architectName: typeof payload.architectName === 'string' ? payload.architectName : '',
  });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  const created = await ravenCreateProject(stored.key, built.draft);
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 502 });
  const buildId = buildIdFromResponse(created.data);
  if (!buildId) {
    return NextResponse.json({ error: 'Raven Colonial не вернул buildId проекта' }, { status: 502 });
  }

  // Привязка к командиру — чтобы проект попал в «мои проекты» на сайте и в Helper.
  // Сам проект уже создан, поэтому ошибка привязки не отменяет результат.
  let linkError: string | null = null;
  if (stored.cmdrName) {
    const link = await ravenLinkCommander(stored.key, buildId, stored.cmdrName);
    if (!link.ok) linkError = link.error;
  }

  return NextResponse.json({ ok: true, buildId, linkError });
}
