// ═══════════════════════════════════════════════════════════════
// Auto-update project progress from colonisation events
// ═══════════════════════════════════════════════════════════════

import { createServiceClient } from '@/lib/supabaseServer';

export interface ConstructionResource {
  name: string;
  nameLocalised: string;
  requiredAmount: number;
  providedAmount: number;
  payment: number;
}

export async function updateProjectProgress(
  systemName: string,
  progress: number,
  resources: ConstructionResource[],
  source: 'journal' | 'capi' = 'journal'
): Promise<{ updated: boolean; newStatus?: string; systemsAffected: number } | null> {
  const svc = createServiceClient();

  // Find project_systems by exact name match
  const { data: projectSystems } = await svc
    .from('project_systems')
    .select('id, project_id, system_name, planned_status')
    .ilike('system_name', systemName);

  if (!projectSystems || projectSystems.length === 0) {
    return null;
  }

  // Create snapshot
  await svc.from('construction_depot_snapshots').insert({
    system_name: systemName,
    progress,
    resources_total: resources,
    snapshot_at: new Date().toISOString(),
    source,
  });

  // Update project_systems status
  const newStatus = progress >= 100 ? 'done' : progress > 0 ? 'building' : 'planned';

  for (const ps of projectSystems) {
    if (ps.planned_status !== newStatus) {
      await svc
        .from('project_systems')
        .update({ planned_status: newStatus })
        .eq('id', ps.id);
    }

    // Update commodity_needs
    for (const res of resources) {
      await svc
        .from('commodity_needs')
        .upsert(
          {
            project_id: ps.project_id,
            system_name: systemName,
            commodity_name: res.name,
            amount_required: res.requiredAmount,
            amount_provided: res.providedAmount,
            payment_per_ton: res.payment,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'project_id,system_name,commodity_name' }
        );
    }
  }

  return { updated: true, newStatus, systemsAffected: projectSystems.length };
}
