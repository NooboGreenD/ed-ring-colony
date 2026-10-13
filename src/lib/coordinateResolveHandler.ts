import { NextResponse } from 'next/server';
import { resolveSystemCoordinates } from './systemCoordinates';
/** Shared implementation for both historical batch endpoints. */
export async function coordinateResolvePOST(request: Request) {
  const body = await request.json().catch(() => null);
  if (
    !Array.isArray(body?.names) ||
    !body.names.length ||
    body.names.length > 100 ||
    body.names.some(
      (name: unknown) =>
        typeof name !== 'string' || !name.trim() || name.length > 200
    )
  ) {
    return NextResponse.json(
      {
        error:
          'Нужен список от 1 до 100 непустых названий систем (до 200 символов).',
      },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json(await resolveSystemCoordinates(body.names), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Не удалось получить координаты из EDSM и Spansh.' },
      { status: 503 }
    );
  }
}
