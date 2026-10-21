import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { communityGoalIdentityKey } from '@/lib/inara/community-goals.mjs';

export const dynamic = 'force-dynamic';

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
  let query = svc.from('community_goals').select('*');

  if (filter === 'active') {
    query = query.eq('is_complete', false);
  } else if (filter === 'colonisation') {
    query = query.eq('is_colonisation_related', true).eq('is_complete', false);
  } else if (filter === 'completed') {
    query = query.eq('is_complete', true);
  }

  const { data, error } = await query.order('expiry_date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const goals = data || [];
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

  const enrichedGoals = goals.map((goal) => ({
    ...goal,
    commander_reports: reportSummary.get(identityByGoalId.get(goal.id) || '') || null,
  }));
  const lastUpdated = goals
    .map((goal) => goal.updated_at || goal.source_updated_at)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1) || null;

  return NextResponse.json({ goals: enrichedGoals, updatedAt: lastUpdated });
}
