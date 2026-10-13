import { NextResponse } from 'next/server';
import { resolveRingSystem } from '@/lib/atlasRingSearch';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Только координаты для превью: не создаёт сессию и не перебирает сегменты. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const start = params.get('start_system')?.trim();
  const center = params.get('center_system')?.trim() || 'Sagittarius A*';
  if (!start || start.length > 200 || center.length > 200) {
    return NextResponse.json({ error: 'Укажите корректные имена систем' }, { status: 400 });
  }
  try {
    const [startPoint, centerPoint] = await Promise.all([resolveRingSystem(start), resolveRingSystem(center)]);
    if (!startPoint || !centerPoint) {
      return NextResponse.json({ error: 'Не удалось получить координаты старта или центра кольца' }, { status: 404 });
    }
    return NextResponse.json({ start: startPoint, center: centerPoint });
  } catch {
    return NextResponse.json({ error: 'Не удалось загрузить предварительный контур кольца' }, { status: 503 });
  }
}
