import { NextResponse } from 'next/server';
import { findHubsForAnchors, type AnchorHubResult } from '@/lib/atlasRingHubSearch';

/**
 * Поиск кандидатов на строительные хабы рядом с опорными точками кольца.
 *
 * Принимает список опор (имя + координаты), обходит их в радиусе 14.99 св.л,
 * ищет каменистые тела с возможностью посадки (из кэша Atlas, БД проекта,
 * Spansh, EDSM). Возвращает результат по каждой опоре: найден хаб (зелёная
 * метка на карте) или нет (красная метка с примечанием).
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface AnchorInput {
  name: string;
  x: number;
  y: number;
  z: number;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const anchorsInput: AnchorInput[] = Array.isArray(body?.anchors) ? body.anchors : [];
    const spanshBudget = Math.min(20, Math.max(0, Number(body?.spansh_budget) || 10));

    if (anchorsInput.length === 0) {
      return NextResponse.json({ error: 'Нет опорных точек для поиска хабов' }, { status: 400 });
    }

    const anchors = anchorsInput
      .map((a) => ({
        name: String(a.name || ''),
        x: Number(a.x),
        y: Number(a.y),
        z: Number(a.z),
      }))
      .filter((a) => a.name && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z));

    if (anchors.length === 0) {
      return NextResponse.json({ error: 'Опорные точки не содержат валидных координат' }, { status: 400 });
    }

    const startedAt = Date.now();
    const results: AnchorHubResult[] = [];
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // Поиск идёт пачками параллельно: клиент получает прогресс по SSE,
    // чтобы рисовать найденные хабы на карте по мере поступления.
    const BATCH = 6;
    const processAll = (async () => {
      for (let offset = 0; offset < anchors.length; offset += BATCH) {
        const batch = anchors.slice(offset, offset + BATCH);
        const batchResults = await findHubsForAnchors(batch, {
          spanshBudget: Math.max(0, spanshBudget - results.filter(r => r.hub.source === 'spansh').length),
          concurrency: BATCH,
          onProgress: (done, _total, latest) => {
            // done — количество завершённых опор ВНУТРИ текущего батча (1..BATCH).
            // Абсолютный индекс = offset + done - 1.
            const absoluteIndex = offset + done - 1;
            writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'hub', hub: latest, index: absoluteIndex })}\n\n`));
          },
        });
        results.push(...batchResults);
        writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'progress', done: results.length, total: anchors.length })}\n\n`));
      }
      const found = results.filter(r => r.hub.status === 'found').length;
      const missing = results.filter(r => r.hub.status === 'missing').length;
      const errors = results.filter(r => r.hub.status === 'error').length;
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'done', results, found, missing, errors, elapsedMs: Date.now() - startedAt })}\n\n`));
      await writer.close();
    })().catch(async (error) => {
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Ошибка поиска хабов' })}\n\n`));
      await writer.close();
    });

    // Не ждём завершения — SSE начинает течь сразу. processAll пишет в stream
    // в фоне и сам закроет writer по окончании; ошибки обрабатываются внутри.
    processAll.catch(() => { /* уже обработано внутри */ });

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error: any) {
    console.error('[ring-hubs] ошибка:', error);
    return NextResponse.json({ error: error?.message || 'Ошибка поиска хабов' }, { status: 500 });
  }
}
