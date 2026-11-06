import { NextResponse } from 'next/server';
import { finalizeRingSession } from '@/lib/atlasRingSearch';
import { apiTranslate } from '@/lib/i18n/apiT';

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
  const t = await apiTranslate();
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.session_id || '').trim();
    if (!sessionId) {
      return NextResponse.json({ error: t('api.ringSessionRequired') }, { status: 400 });
    }

    const result = await finalizeRingSession(sessionId);
    return NextResponse.json({
      result,
      progress: {
        percent: 100,
        stage: 'done',
        message: t('api.ringAssembled', { points: result.route.length, synthetic: result.totals.syntheticPoints }),
      },
    });
  } catch (error: any) {
    console.error('[ring-route/finalize] ошибка:', error);
    return NextResponse.json({ error: error?.message || t('api.ringAssembleFailed') }, { status: 500 });
  }
}
