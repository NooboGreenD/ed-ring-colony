/**
 * Стройки из журнала → проекты эскадрилий (и их участники).
 *
 * Раньше статус систем в проектах эскадрилий двигала только синхронизация
 * Frontier CAPI (`updateProjectProgress`), а журналы, загруженные через сайт
 * или Colonial Helper, писали состояние площадок в `colonisation_sites`, но
 * проекты о нём не узнавали. Теперь все три пути после записи площадок зовут
 * одну реакцию:
 *
 *   1. `sync_project_systems_from_sites` (SQL, миграция 20261020120000)
 *      продвигает статус систем проектов только вперёд — planned → building →
 *      done (done — когда все известные площадки системы достроены);
 *   2. участники проекта получают уведомление в колокольчик (`notify.ts`):
 *      «стройка началась» / «стройка завершена».
 *
 * Сбой реакции не роняет загрузку журнала: возвращается предупреждение.
 */

import { systemKey } from '../systemIdentity.ts';
import { notifyUsers } from '../notify.ts';

type Svc = any;

export interface ProjectSystemChange {
  id: number;
  project_id: number;
  project_name: string | null;
  system_name: string;
  status: 'building' | 'done' | string;
}

export interface ProjectSyncResult {
  changed: ProjectSystemChange[];
  notified: number;
  warning: string | null;
}

const MAX_KEYS = 1000;

function parseChanges(value: unknown): ProjectSystemChange[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { changed?: unknown }).changed)
    ? (raw as { changed: unknown[] }).changed
    : [];
  return list.filter((item): item is ProjectSystemChange =>
    !!item && typeof item === 'object' && typeof (item as ProjectSystemChange).system_name === 'string');
}

function statusText(status: string): string {
  if (status === 'done') return 'стройка завершена';
  if (status === 'building') return 'стройка началась';
  return `статус: ${status}`;
}

/**
 * Продвинуть статусы систем проектов эскадрилий по площадкам из журнала и
 * уведомить участников. `actorId` — кто прислал журнал (себе не уведомляем).
 */
export async function syncProjectsFromSites(
  svc: Svc,
  systemNames: Iterable<string | null | undefined>,
  options: { actorId?: string | null; notify?: boolean } = {},
): Promise<ProjectSyncResult> {
  const keys = new Set<string>();
  for (const name of systemNames) {
    const key = systemKey(name);
    if (key) keys.add(key);
    if (keys.size >= MAX_KEYS) break;
  }
  const result: ProjectSyncResult = { changed: [], notified: 0, warning: null };
  if (keys.size === 0) return result;

  try {
    const { data, error } = await svc.rpc('sync_project_systems_from_sites', { p_keys: Array.from(keys) });
    if (error) throw new Error(error.message);
    result.changed = parseChanges(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warning = /sync_project_systems_from_sites|schema cache|does not exist/i.test(message)
      ? 'статусы проектов эскадрилий из журнала ждут миграцию 20261020120000_unified_system_data.sql'
      : `статусы проектов эскадрилий не обновлены: ${message}`;
    return result;
  }
  if (result.changed.length === 0 || options.notify === false) return result;

  // Участники каждого затронутого проекта — одним запросом.
  try {
    const projectIds = Array.from(new Set(result.changed.map((change) => Number(change.project_id)).filter(Number.isFinite)));
    const { data: members, error } = await svc
      .from('project_members')
      .select('project_id, user_id')
      .in('project_id', projectIds);
    if (error) throw new Error(error.message);
    const byProject = new Map<number, string[]>();
    for (const row of Array.isArray(members) ? members : []) {
      const list = byProject.get(Number(row.project_id)) ?? [];
      if (typeof row.user_id === 'string') list.push(row.user_id);
      byProject.set(Number(row.project_id), list);
    }
    for (const change of result.changed) {
      const recipients = byProject.get(Number(change.project_id)) ?? [];
      const projectName = change.project_name || `проект #${change.project_id}`;
      const sent = await notifyUsers(svc, recipients, {
        type: 'project_system',
        title: `${projectName}: ${change.system_name}`,
        body: `${statusText(change.status)} — по данным журнала пилота`,
        href: `/projects/${change.project_id}`,
        metadata: { project_id: change.project_id, system_name: change.system_name, status: change.status },
      }, { exclude: options.actorId ?? null });
      result.notified += sent.inserted;
    }
  } catch (error) {
    result.warning = `уведомления участникам проектов не отправлены: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
}
