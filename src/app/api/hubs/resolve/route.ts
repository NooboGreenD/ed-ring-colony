import { NextResponse } from 'next/server';
import { resolveSystemCoordinates } from '@/lib/systemCoordinates';
import { apiTranslate } from '@/lib/i18n/apiT';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  const t = await apiTranslate();
  const name = new URL(request.url).searchParams.get('name');
  if (!name?.trim() || name.length > 200)
    return NextResponse.json(
      { error: t('api.systemNameExpected') },
      { status: 400 }
    );
  const resolved = await resolveSystemCoordinates([name]);
  const coords = resolved.results[name];
  if (!coords)
    return NextResponse.json(
      {
        error:
          t('hubs.coordsMissing'),
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
