import { NextResponse } from 'next/server';
import regionPack from '@/lib/galacticRegions.json';

const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };

export async function GET() {
  const regions = (regionPack as any).regions.map((region: any) => {
    const xsGalactic = region.path.map((point: number[]) => point[0] + SAGA.x);
    const zsGalactic = region.path.map((point: number[]) => point[1] + SAGA.z);
    const min_x = Math.min(...xsGalactic);
    const max_x = Math.max(...xsGalactic);
    const min_z = Math.min(...zsGalactic);
    const max_z = Math.max(...zsGalactic);

    const centerX = SAGA.x + region.cx;
    const centerZ = SAGA.z + region.cz;
    const distToSol = Math.round(Math.hypot(centerX, centerZ));
    const distToSgrA = Math.round(Math.hypot(region.cx, region.cz));

    let category = 'arm';
    if (region.id === 1 || distToSgrA < 8000) {
      category = 'core';
    } else if (region.id === 18 || distToSol < 15000) {
      category = 'sol';
    } else if (distToSol > 45000) {
      category = 'rim';
    }

    return {
      id: region.id,
      name: region.name,
      center: {
        x: Number(centerX.toFixed(1)),
        y: 0,
        z: Number(centerZ.toFixed(1)),
      },
      bounds: {
        min_x: Math.round(min_x),
        max_x: Math.round(max_x),
        min_z: Math.round(min_z),
        max_z: Math.round(max_z),
      },
      dimensions: {
        width: Math.round(max_x - min_x),
        length: Math.round(max_z - min_z),
      },
      distanceToSol: distToSol,
      distanceToSgrA: distToSgrA,
      verticesCount: region.path.length,
      category,
      pathSample: region.path.slice(0, 8),
    };
  });

  return NextResponse.json({
    total: regions.length,
    regions,
  });
}
