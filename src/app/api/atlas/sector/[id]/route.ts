import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import regionPack from '@/lib/galacticRegions.json';
const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };

function inside(x: number, z: number, path: number[][]) {
  let result = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [xi, zi] = path[i]; const [xj, zj] = path[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) result = !result;
  }
  return result;
}

export async function GET(_request: Request, context: { params: { id: string } }) {
  const id = Number(context.params.id);
  const region = (regionPack as any).regions.find((item: any) => item.id === id);
  if (!region) return NextResponse.json({ error: 'Сектор не найден' }, { status: 404 });
  try {
    const service = createServiceClient();
    const { data, error } = await service.from('atlas_ring_system_cache').select('system_name,x,y,z,source').limit(100_000);
    if (error) throw error;
    const systems = (data || []).filter((item: any) => inside(Number(item.x) - SAGA.x, Number(item.z) - SAGA.z, region.path));
    const realSystems = systems.filter((item: any) => item.source !== 'triangulated');
    const xs = region.path.map((point: number[]) => point[0]); const zs = region.path.map((point: number[]) => point[1]);
    return NextResponse.json({
      id: region.id, name: region.name, center: { x: SAGA.x + region.cx, y: 0, z: SAGA.z + region.cz },
      bounds: { min_x: Math.min(...xs) + SAGA.x, max_x: Math.max(...xs) + SAGA.x, min_z: Math.min(...zs) + SAGA.z, max_z: Math.max(...zs) + SAGA.z },
      statistics: { cached_systems: systems.length, known_real_systems: realSystems.length, inhabited_systems: null, explored_percent: null },
      source: 'Кэш Atlas; полная статистика EDSM/EDAstro уточняется по мере накопления данных',
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить статистику сектора' }, { status: 500 });
  }
}
