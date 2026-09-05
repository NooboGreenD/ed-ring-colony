import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { searchParams } = new URL(req.url);
  const locale = searchParams.get('locale') || 'ru';

  const supabase = await createClient();
  const { data: item } = await supabase
    .from('news')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (!item) {
    return NextResponse.json({ item: null });
  }

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;

  const normalized = {
    ...item,
    title: (item as any)[titleCol] || item.title || '',
    body: (item as any)[bodyCol] || item.body || '',
  };

  return NextResponse.json({ item: normalized });
}
