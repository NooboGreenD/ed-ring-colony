import { NextResponse } from 'next/server';
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('name');
  if (!name)
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  const url =
    'https://www.edsm.net/api-v1/system?showCoordinates=1&systemName=' +
    encodeURIComponent(name);
  const res = await fetch(url, { next: { revalidate: 86400 } });
  const data = await res.json();
  if (!data || !data.coords)
    return NextResponse.json(
      { error: 'Система не найдена в EDSM' },
      { status: 404 }
    );
  return NextResponse.json({
    system_name: data.name,
    x: data.coords.x,
    y: data.coords.y,
    z: data.coords.z,
  });
}