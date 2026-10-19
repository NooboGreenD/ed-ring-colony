/**
 * Координаты опорной системы для поисков по станциям и рынкам — только из БД
 * проекта: сначала `commerce_systems` (системы, о станциях которых есть
 * данные), затем каталог систем (`galaxy_systems`). Ключ — `systemKey`
 * (ARCHITECTURE.md §7.1). Внешние сервисы здесь не спрашиваются.
 */
import { findSystemByName } from '@/lib/galaxySystemsDb';
import type { createServiceClient } from '@/lib/supabaseServer';
import { cleanSystemName, systemKey } from '@/lib/systemIdentity';

export interface ReferencePoint {
  x: number;
  y: number;
  z: number;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

const finite = (value: unknown) => value != null && value !== '' && Number.isFinite(Number(value));

/** Координаты системы или null, если её нет ни в одном справочнике. */
export async function referenceSystemCoords(client: ServiceClient, name: string): Promise<ReferencePoint | null> {
  const key = systemKey(name);
  if (!key) return null;
  const { data, error } = await client.from('commerce_systems').select('x,y,z').eq('name_lc', key).maybeSingle();
  if (error) throw new Error(error.message);
  if (data && finite(data.x) && finite(data.y) && finite(data.z)) {
    return { x: Number(data.x), y: Number(data.y), z: Number(data.z) };
  }
  const row = await findSystemByName(cleanSystemName(name));
  return row ? { x: row.x, y: row.y, z: row.z } : null;
}
