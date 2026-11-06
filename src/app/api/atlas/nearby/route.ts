import { NextResponse } from 'next/server';
import { searchNearbySystems } from '@/lib/atlasNearbySearch';
import { apiTranslate } from '@/lib/i18n/apiT';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  const t = await apiTranslate();
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.reference_system !== 'string' ||
    !body.reference_system.trim() ||
    body.reference_system.length > 200 ||
    !['sphere', 'cube'].includes(body.shape) ||
    !Number.isFinite(body.radius) ||
    body.radius < 1 ||
    body.radius > 50
  ) {
    return NextResponse.json(
      { error: t('api.nearbyParams') },
      { status: 400 }
    );
  }
  try {
    const result = await searchNearbySystems(
      body.reference_system.trim(),
      body.shape,
      body.radius
    );
    if (result.sources.every((source) => source.status === 'unavailable'))
      return NextResponse.json(
        {
          ...result,
          error: t('api.nearbyAllSourcesDown'),
        },
        { status: 503 }
      );
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Не удалось выполнить поиск',
      },
      { status: 503 }
    );
  }
}
