import { NextResponse } from 'next/server';
import { readAllRows } from '@/lib/readAllRows';
import {
  buildProjectLeaders,
  isLeaderPeriod,
  periodSince,
  type ActivityRow,
  type ContributionRow,
  type LeaderPeriod,
  type PilotInfo,
} from '@/lib/architect/projectLeaders';
import { siteDirectory } from '@/lib/architect/projectProgress';
import { isProjectRole } from '@/lib/architect/projects';
import {
  computeProjectProgress,
  loadCarrierLinks,
  loadCarrierRows,
  loadMemberRows,
  loadProfiles,
  loadSystemRows,
} from '@/lib/architect/projectStore';
import { errorResponse, openProject } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';

/**
 * Лидеры проекта систем: кто сколько какого груза привёз и на какую площадку.
 *
 *   GET ?period=all|90d|30d|7d&scope=all|members
 *
 * Суммы считает SQL (`architect_project_contributions` и
 * `architect_project_activity`, только service_role), свод и подписи —
 * `buildProjectLeaders`. Участники проекта видны по имени всегда; посторонний
 * пилот, закрывший поставки в приватности, — «Скрытый командир N».
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const projectId = access.project.id;
    const url = new URL(req.url);
    const rawPeriod = url.searchParams.get('period');
    const period: LeaderPeriod = isLeaderPeriod(rawPeriod) ? rawPeriod : 'all';
    const scope = url.searchParams.get('scope') === 'members' ? 'members' : 'all';
    const since = periodSince(period);

    const [contributions, activity, memberRows, systemRows, linkRows] = await Promise.all([
      readAllRows<ContributionRow>((from, to) => svc
        .rpc('architect_project_contributions', { p_project_id: projectId, p_since: since })
        .order('user_id', { ascending: true })
        .order('target', { ascending: true })
        .order('system_name', { ascending: true, nullsFirst: true })
        .order('market_id', { ascending: true, nullsFirst: true })
        .order('commodity', { ascending: true })
        .range(from, to)),
      readAllRows<ActivityRow>((from, to) => svc
        .rpc('architect_project_activity', { p_project_id: projectId, p_since: since })
        .order('day', { ascending: true })
        .order('user_id', { ascending: true })
        .order('target', { ascending: true })
        .range(from, to)),
      loadMemberRows(svc, projectId),
      loadSystemRows(svc, projectId),
      loadCarrierLinks(svc, projectId),
    ]);
    if (contributions.error) throw new Error(contributions.error.message);
    if (activity.error) throw new Error(activity.error.message);

    const memberRoles = new Map(memberRows.map((row) => [String(row.user_id), isProjectRole(row.role) ? row.role : 'member' as const]));
    const userIds = new Set<string>(memberRoles.keys());
    for (const row of contributions.data) if (row.user_id) userIds.add(String(row.user_id));

    const [profiles, progress, carrierRows] = await Promise.all([
      loadProfiles(svc, userIds),
      computeProjectProgress(svc, projectId, systemRows, { includePlans: false }),
      loadCarrierRows(svc, linkRows.map((row) => String(row.carrier_id))),
    ]);

    const pilots = new Map<string, PilotInfo>();
    for (const id of userIds) {
      const profile = profiles.get(id);
      const role = memberRoles.get(id) ?? null;
      pilots.set(id, {
        name: profile?.name ?? null,
        member: role !== null,
        role,
        hidden: role === null && profile?.showDeliveries === false,
      });
    }
    const carriers = new Map<string, string>();
    for (const [id, row] of carrierRows) {
      const label = [row.name, row.callsign].filter(Boolean).join(' · ');
      carriers.set(id, label || `Авианосец ${id}`);
    }

    const view = buildProjectLeaders({
      rows: contributions.data,
      activity: activity.data,
      pilots,
      sites: siteDirectory(progress),
      carriers,
      scope,
      viewerId: userId,
      period,
      since,
    });
    return NextResponse.json({
      ...view,
      trackingSince: access.project.tracking_since ?? null,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
