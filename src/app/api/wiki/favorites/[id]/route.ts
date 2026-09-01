import { NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabaseServer';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const supabase = createRouteClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('wiki_favorites')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
