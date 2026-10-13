import { NextResponse } from 'next/server';
import { resolveSystemCoordinates } from '@/lib/systemCoordinates';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get('name');
  if (!name?.trim() || name.length > 200)
    return NextResponse.json(
      { error: 'Укажите название системы (до 200 символов).' },
      { status: 400 }
    );
  const resolved = await resolveSystemCoordinates([name]);
  const coords = resolved.results[name];
  if (!coords)
    return NextResponse.json(
      {
        error:
          'Координаты системы не найдены в EDSM и Spansh либо источники недоступны.',
        warnings: resolved.warnings,
      },
      { status: resolved.warnings.length ? 503 : 404 }
    );
  return NextResponse.json(
    {
      system_name: resolved.canonical_names[name],
      ...coords,
      source: resolved.sources[name],
      warnings: resolved.warnings,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
