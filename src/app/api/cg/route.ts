import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { communityGoalIdentityKey } from '@/lib/inara/community-goals.mjs';
import { effectiveCommunityGoal } from '@/lib/communityGoalAdmin';
import { readAllRows } from '@/lib/readAllRows';

export const dynamic = 'force-dynamic';

interface ContributionHistoryRow {
  cg_id: number;
  snapshot_hour: string;
  observed_at: string;
  source: 'inara' | 'capi' | 'frontier';
  contributions_total: number | string;
}

interface CommanderReportRow {
  user_id: string;
  goal_key: string;
  player_contribution: number | string;
  current_total: number | string | null;
  observed_at: string;
}

function safeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedFilter = url.searchParams.get('filter') || 'active';
  const filter = ['active', 'colonisation', 'completed'].includes(requestedFilter)
    ? requestedFilter
    : 'active';

  const svc = createServiceClient();
  const result = await readAllRows((from, to) => svc
    .from('community_goals')
    .select('*')
    .eq('moderation_status', 'approved')
    .order('expiry_date', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  const allGoals: Record<string, any>[] = result.data.map((goal: unknown) =>
    effectiveCommunityGoal(goal as Record<string, any>));
  const goals = allGoals.filter((goal) => {
    if (filter === 'active') return goal.is_complete !== true;
    if (filter === 'colonisation') return goal.is_complete !== true && goal.is_colonisation_related === true;
    if (filter === 'completed') return goal.is_complete === true;
    return true;
  });
  const identityByGoalId = new Map<number, string>();
  for (const goal of goals) {
    const identityKey = goal.identity_key || communityGoalIdentityKey({
      title: goal.title,
      systemName: goal.system_name,
      stationName: goal.station_name,
      expiryDate: goal.expiry_date,
    });
    identityByGoalId.set(goal.id, identityKey);
  }

  const identities = Array.from(new Set(identityByGoalId.values()));
  const goalCatalogIds = Array.from(new Set(goals
    .map((goal) => Number(goal.cg_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)));
  const progressHistoryByGoal = new Map<number, ContributionHistoryRow[]>();
  if (goalCatalogIds.length > 0) {
    const historyResult = await readAllRows((from, to) => svc
      .from('community_goal_progress_history')
      .select('cg_id,snapshot_hour,observed_at,source,contributions_total')
      .in('cg_id', goalCatalogIds)
      .order('snapshot_hour', { ascending: true })
      .order('cg_id', { ascending: true })
      .range(from, to));
    if (historyResult.error) {
      console.warn('[CG] Contribution history unavailable:', historyResult.error.message);
    } else {
      for (const point of historyResult.data as ContributionHistoryRow[]) {
        if (!progressHistoryByGoal.has(point.cg_id)) progressHistoryByGoal.set(point.cg_id, []);
        progressHistoryByGoal.get(point.cg_id)!.push(point);
      }
    }
  }

  let reportRows: CommanderReportRow[] = [];
  if (identities.length > 0) {
    const { data: reports, error: reportsError } = await svc
      .from('community_goal_commander_reports')
      .select('user_id,goal_key,player_contribution,current_total,observed_at')
      .in('goal_key', identities);
    if (reportsError) {
      // Keep Inara's canonical listing available if the optional report table
      // is temporarily not migrated or not reachable.
      console.warn('[CG] Commander reports unavailable:', reportsError.message);
    } else {
      reportRows = (reports || []) as CommanderReportRow[];
    }
  }

  // The table has the latest snapshot per account/game CG ID. Collapse again
  // per account/normalized goal in case Frontier reissued a goal ID.
  const perGoal = new Map<string, Map<string, CommanderReportRow>>();
  for (const report of reportRows) {
    if (!perGoal.has(report.goal_key)) perGoal.set(report.goal_key, new Map());
    const perCommander = perGoal.get(report.goal_key)!;
    const previous = perCommander.get(report.user_id);
    if (!previous || report.observed_at > previous.observed_at) {
      perCommander.set(report.user_id, report);
    }
  }

  const reportSummary = new Map<string, {
    commander_count: number;
    player_contribution_total: number;
    journal_current_total: number | null;
    reported_at: string | null;
  }>();
  for (const [identity, commanders] of perGoal) {
    const rows = Array.from(commanders.values());
    const latest = rows.reduce<CommanderReportRow | null>((current, row) =>
      !current || row.observed_at > current.observed_at ? row : current, null);
    reportSummary.set(identity, {
      commander_count: rows.length,
      player_contribution_total: rows.reduce((total, row) => total + (safeInteger(row.player_contribution) ?? 0), 0),
      journal_current_total: latest ? safeInteger(latest.current_total) : null,
      reported_at: latest?.observed_at || null,
    });
  }

  const enrichedGoals: Array<Record<string, any>> = goals.map((goal) => ({
    ...goal,
    commander_reports: reportSummary.get(identityByGoalId.get(goal.id) || '') || null,
  }));
  const lastUpdated = goals
    .map((goal) => goal.updated_at || goal.source_updated_at)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1) || null;

  const publicGoals = enrichedGoals.map((goal) => ({
    id: goal.id,
    cg_id: goal.cg_id,
    title: goal.title,
    description: goal.description,
    system_name: goal.system_name,
    station_name: goal.station_name,
    objective: goal.objective,
    reward: goal.reward,
    tier_current: goal.tier_current,
    tier_max: goal.tier_max,
    contributors: goal.contributors,
    contributions_total: goal.contributions_total,
    contributions_target: goal.contributions_target ?? null,
    is_complete: goal.is_complete,
    is_colonisation_related: goal.is_colonisation_related,
    expiry_date: goal.expiry_date,
    inara_url: goal.inara_url,
    source_updated_at: goal.source_updated_at,
    progress_source: goal.progress_source,
    progress_updated_at: goal.progress_updated_at,
    contribution_history: progressHistoryByGoal.get(Number(goal.cg_id)) || [],
    updated_at: goal.updated_at,
    commander_reports: goal.commander_reports,
  }));

  return NextResponse.json({ goals: publicGoals, updatedAt: lastUpdated });
}
