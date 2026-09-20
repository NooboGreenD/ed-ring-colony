import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const { user, supabase } = await authFromRequest(request);
  
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('wiki_favorites')
    .delete()
    .eq('id', resolvedParams.id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
