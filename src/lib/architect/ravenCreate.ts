/**
 * Черновик проекта Raven Colonial для постройки плана Архитектора.
 *
 * Чистый модуль (без сети и БД): собирает тело `PUT /api/project` и проверяет
 * то, без чего Raven не создаст проект или откроет его с ошибкой. Тип
 * постройки берётся из каталога сайта — его id совпадают с кодами Raven
 * (см. `uploader/colony_build_types.py`), поэтому неизвестный код сюда не попадает.
 */
import { getInstallation } from './planner.ts';
import type { ArchitectBody, PlannedSite } from './types.ts';

export interface RavenDraftInput {
  site: PlannedSite;
  body: ArchitectBody | null;
  systemName: string;
  /** Адрес системы (SystemAddress) — обязателен для Raven. */
  systemAddress: number;
  /** MarketID стройплощадки из игры — обязателен для Raven. */
  marketId: number;
  buildName: string;
  architectName?: string;
}

export type RavenDraftResult =
  | { ok: true; draft: Record<string, unknown> }
  | { ok: false; error: string };

const positiveInt = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export function buildRavenProjectDraft(input: RavenDraftInput): RavenDraftResult {
  const { site } = input;
  if (site.ravenBuildId) {
    return { ok: false, error: 'Эта постройка уже связана с проектом Raven — повторно не создаём.' };
  }
  const installation = getInstallation(site.installationId);
  if (!installation) {
    return { ok: false, error: `Неизвестная постройка «${site.installationId}» — Raven её не примет.` };
  }
  const marketId = positiveInt(input.marketId);
  if (!marketId) {
    return { ok: false, error: 'Укажите MarketID стройплощадки из игры (Construction Services).' };
  }
  const systemAddress = positiveInt(input.systemAddress);
  if (!systemAddress) {
    return { ok: false, error: 'Укажите SystemAddress системы (адрес из журнала или из Raven).' };
  }
  const buildName = String(input.buildName ?? '').trim().slice(0, 120);
  if (!buildName) {
    return { ok: false, error: 'Укажите название проекта.' };
  }

  const draft: Record<string, unknown> = {
    marketId,
    systemAddress,
    buildName,
    systemName: input.systemName,
    buildType: installation.id,
  };
  const bodyName = input.body?.name || site.bodyName;
  if (bodyName) draft.bodyName = bodyName;
  if (input.body && input.body.bodyId !== null && input.body.bodyId !== undefined) {
    draft.bodyNum = input.body.bodyId;
  }
  if (input.architectName?.trim()) draft.architectName = input.architectName.trim().slice(0, 120);
  if (site.note) draft.notes = site.note;
  if (site.primary) draft.isPrimaryPort = true;
  return { ok: true, draft };
}
