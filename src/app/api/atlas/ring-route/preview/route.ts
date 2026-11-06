import { NextResponse } from 'next/server';
import { resolveRingSystem } from '@/lib/atlasRingSearch';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Только координаты для превью: не создаёт сессию и не перебирает сегменты. */
export async function GET(request: Request) {
  const t = await apiTranslate();
  const params = new URL(request.url).searchParams;
  const start = params.get('start_system')?.trim();
  const center = params.get('center_system')?.trim() || 'Sagittarius A*';
  if (!start || start.length > 200 || center.length > 200) {
    return NextResponse.json({ error: t('api.ringNamesInvalid') }, { status: 400 });
  }
  try {
    const [startPoint, centerPoint] = await Promise.all([resolveRingSystem(start), resolveRingSystem(center)]);
    if (!startPoint || !centerPoint) {
      return NextResponse.json({ error: t('api.ringCoordinatesMissing') }, { status: 404 });
    }
    return NextResponse.json({ start: startPoint, center: centerPoint });
  } catch {
    return NextResponse.json({ error: t('api.ringPreviewFailed') }, { status: 503 });
  }
}
