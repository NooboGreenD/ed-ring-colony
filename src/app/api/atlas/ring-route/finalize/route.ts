import { NextResponse } from 'next/server';
import { finalizeRingSession } from '@/lib/atlasRingSearch';

/**
 * Сборка замкнутого кольца из пройденных сегментов.
 *
 * Промежутки между опорными точками закрываются цепочкой реальных систем из
 * каталога Spansh и кэша Atlas; расчётные (триангулированные) точки остаются
 * только там, где реальных систем в коридоре нет физически.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.session_id || '').trim();
    if (!sessionId) {
      return NextResponse.json({ error: 'session_id обязателен' }, { status: 400 });
    }

    const result = await finalizeRingSession(sessionId);
    return NextResponse.json({
      result,
      progress: {
        percent: 100,
        stage: 'done',
        message: `Кольцо собрано: ${result.route.length} точек, расчётных ${result.totals.syntheticPoints}`,
      },
    });
  } catch (error: any) {
    console.error('[ring-route/finalize] ошибка:', error);
    return NextResponse.json({ error: error?.message || 'Не удалось собрать маршрут кольца' }, { status: 500 });
  }
}
