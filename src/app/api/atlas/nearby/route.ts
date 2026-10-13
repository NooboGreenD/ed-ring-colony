import { NextResponse } from 'next/server';
import { searchNearbySystems } from '@/lib/atlasNearbySearch';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
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
      { error: 'Укажите систему, сферу/куб и радиус от 1 до 50 св.л.' },
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
          error: 'Ни один источник не ответил. Повторите поиск позже.',
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
