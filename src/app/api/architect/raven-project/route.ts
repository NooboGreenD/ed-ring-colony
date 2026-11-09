import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { loadRavenKey } from '@/lib/raven/keyStore';
import {
  buildIdFromResponse,
  ravenCreateProject,
  ravenLinkCommander,
} from '@/lib/raven/client';
import { buildRavenProjectDraft } from '@/lib/architect/ravenCreate';
import { normalizeProjectRegistration } from '@/lib/siteProjects';
import type { ArchitectBody, PlannedSite } from '@/lib/architect/types';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * Создать проект постройки плана: сначала на сайте, потом в Raven Colonial.
 *
 * Порядок принципиален. Raven Colonial отвечает 503 на проверку RCC-ключа, и
 * раньше из-за этого нельзя было создать вообще ничего: панель требовала
 * сначала сохранить ключ. Теперь проект пишется в `construction_projects`
 * («сайт проекта — источник истины»), а Raven — вторичная синхронизация:
 * без ключа или при его отказе проект остаётся на сайте, `rc_state` честно
 * говорит «no_key» / «unavailable», а `buildId` досылается позже.
 *
 * Клиент получает `buildId` (если Raven ответил) и сам ставит его в запись
 * плана (`ravenBuildId`): дальше эта постройка узнаётся при каждой
 * синхронизации и не дублируется.
 */
export async function POST(req: Request) {
  const t = await apiTranslate();
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
    return NextResponse.json({ error: t('api.jsonExpected') }, { status: 400 });
  }
  if (!payload.site || typeof payload.site !== 'object' || typeof payload.site.id !== 'string') {
    return NextResponse.json({ error: t('api.planBuildingMissing') }, { status: 400 });
  }
  const system = typeof payload.system === 'string' ? payload.system.trim() : '';
  if (!system) return NextResponse.json({ error: t('api.systemNotSpecified') }, { status: 400 });

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

  const stored = await loadRavenKey(user.id);
  if (stored.error) return NextResponse.json({ error: stored.error }, { status: 500 });

  /**
   * Запись проекта на сайт. Она обязательна: именно отсюда проект видят
   * страница системы и оверлей Helper'а, даже когда Raven недоступен.
   */
  const saveOnSite = async (buildId: string | null, rcState: string) => {
    const normalized = normalizeProjectRegistration({
      ...built.draft,
      buildId: buildId ?? undefined,
      architectName: typeof built.draft.architectName === 'string' ? built.draft.architectName : '',
      rcState,
    });
    if (!normalized.ok) return { ok: false as const, error: normalized.error };
    const { error } = await createServiceClient().rpc('construction_project_register', {
      p_project: normalized.value,
      p_user: user.id,
    });
    if (error) {
      const missing = /construction_projects|construction_project_register|schema cache/i.test(error.message);
      return {
        ok: false as const,
        error: missing ? 'construction_projects is not migrated yet' : error.message,
      };
    }
    return { ok: true as const, key: normalized.value.project_key };
  };

  // Ключа нет — состояние Raven честно «no_key», а не «неизвестно»: Helper и
  // панель по нему решают, досылать ли проект позже.
  const noKey = await saveOnSite(null, stored.key ? 'unknown' : 'no_key');
  if (!noKey.ok) {
    return NextResponse.json({ error: noKey.error, hint: t('rvcp.siteSaveFailed') }, { status: 503 });
  }
  if (!stored.key) {
    // Ключа нет — проект уже на сайте, Raven подхватит его при появлении ключа.
    return NextResponse.json({
      ok: true,
      buildId: null,
      siteKey: noKey.key,
      raven: 'no_key',
      warning: t('api.ravenKeyFirst'),
    });
  }

  const created = await ravenCreateProject(stored.key, built.draft);
  if (!created.ok) {
    // Raven отказал — проект остаётся на сайте, причину показываем как есть.
    return NextResponse.json({
      ok: true,
      buildId: null,
      siteKey: noKey.key,
      raven: 'unavailable',
      warning: created.error,
    });
  }
  const buildId = buildIdFromResponse(created.data);
  if (!buildId) {
    return NextResponse.json({
      ok: true,
      buildId: null,
      siteKey: noKey.key,
      raven: 'unavailable',
      warning: t('api.ravenNoBuildId'),
    });
  }

  // Привязка к командиру — чтобы проект попал в «мои проекты» на сайте и в Helper.
  // Сам проект уже создан, поэтому ошибка привязки не отменяет результат.
  let linkError: string | null = null;
  if (stored.cmdrName) {
    const link = await ravenLinkCommander(stored.key, buildId, stored.cmdrName);
    if (!link.ok) linkError = link.error;
  }

  // Второй заход на сайт — уже с buildId: карточка узнаёт проект Raven и
  // перестаёт считаться «несинхронизированной».
  const withBuild = await saveOnSite(buildId, 'ok');
  if (!withBuild.ok) linkError = linkError ? `${linkError} · ${withBuild.error}` : withBuild.error;

  return NextResponse.json({ ok: true, buildId, siteKey: withBuild.ok ? withBuild.key : noKey.key, raven: 'ok', linkError });
}
